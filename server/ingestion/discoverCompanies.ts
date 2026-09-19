/**
 * ingestion/discoverCompanies.ts
 * One-time (well, re-runnable) bulk expansion of data/companies.csv, using
 * community-maintained token lists instead of hand-adding companies one at
 * a time. sync.ts only ever checks companies ALREADY in companies.csv --
 * this is what actually grows that list.
 *
 * data/discovery/{greenhouse,ashby,lever,bamboohr,workday,icims}_tokens.json
 * are plain arrays of board-token strings pulled from
 * github.com/Feashliaa/job-board-aggregator (data/ licensed CC BY-NC 4.0 --
 * non-commercial use only; fine for this portfolio project, but revisit
 * before ever monetizing Tolara Scout). They carry no company display names
 * or confirmation that a token is even live -- just candidate slugs scraped
 * from Common Crawl by that project. data/discovery/paylocity_tokens.json is
 * shaped differently -- `{guid, name, jobs}[]` -- because that source
 * dataset happens to carry a real company name alongside each GUID; see
 * loadCandidates below for how that's used instead of title-casing.
 *
 * For each candidate token NOT already in companies.csv, this hits the
 * same live ATS APIs sync.ts uses (via the same searchGreenhouse/
 * searchAshby/searchLever/searchBambooHr/searchWorkday/searchPaylocity/
 * searchIcims adapters, so retry/timeout/failed-vs-empty handling is
 * identical) and keeps only the ones that are both (a) a real,
 * responding board and (b) currently have at least one Product-Manager-
 * classified posting on it right now -- companies.csv is meant to be a
 * verified, currently-relevant list, not 15,000 unconfirmed slugs. A
 * candidate that resolves but has no PM roles today is just skipped, not
 * added as unverified -- it can be picked up in a future discovery run if
 * that changes.
 *
 * No API here exposes a company's real display name from a token alone
 * (Paylocity's dataset is the one exception, see above), so the token
 * itself is title-cased as a readable stand-in (e.g. "sword-health" ->
 * "Sword Health"). For iCIMS, the subdomain prefix ("careers-",
 * "cacareers-", "jobs-", etc.) is stripped first so the display name reads
 * as the company, not "Careers Sword Health". Good enough to identify the
 * company on the map and in the UI; worth a manual cleanup pass later for
 * any that read awkwardly.
 *
 * Runs sequentially in small concurrent batches per platform (not one
 * giant Promise.all across thousands of boards) to stay a reasonable
 * neighbor to these free public APIs, which -- unlike Nominatim -- publish
 * no rate-limit policy to follow, so this errs conservative rather than
 * assuming unlimited concurrency is fine.
 *
 * Usage: npm run discover
 */

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseCompaniesCsv } from "./csv.js";
import { searchGreenhouse } from "./sources/greenhouse.js";
import { searchAshby } from "./sources/ashby.js";
import { searchLever } from "./sources/lever.js";
import { searchBambooHr } from "./sources/bamboohr.js";
import { searchWorkday, fetchWorkdayCompanyName } from "./sources/workday.js";
import { searchPaylocity } from "./sources/paylocity.js";
import { searchIcims } from "./sources/icims.js";
import { matchesProductManagerFilter } from "./filters/productManager.js";
import type { RawJob, SearchMeta } from "./sources/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "..", "data", "companies.csv");
const DISCOVERY_DIR = path.join(__dirname, "..", "..", "data", "discovery");

// Conservative: enough parallelism to move at a reasonable pace without
// hammering a free public API that publishes no rate-limit policy.
const BATCH_SIZE = 25;
const PAUSE_BETWEEN_BATCHES_MS = 300;

type Platform = "greenhouse" | "ashby" | "lever" | "bamboohr" | "workday" | "paylocity" | "icims";

interface Candidate {
  token: string;
  displayName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCaseToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token); // "P-1%20AI" -> "P-1 AI"
  } catch {
    // not valid percent-encoding -- use as-is
  }
  return decoded
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Strips a subdomain-style ATS prefix ("careers-", "cacareers-", "jobs-", ...) so the title-cased result reads as the company name, not the portal. */
function stripIcimsPrefix(token: string): string {
  return token.replace(/^[a-z]*(?:careers|jobs)-/i, "");
}

/**
 * Every other platform's display name is derived from title-casing a
 * slug, so it never contains a comma or quote. Paylocity's dataset supplies
 * a real free-text company name instead (e.g. "Smith, Jones & Co."), which
 * can -- so this quotes/escapes it the same way parseLine in csv.ts expects
 * to read it back, and leaves slug-derived names untouched.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface PaylocityTokenEntry {
  guid: string;
  name: string;
  jobs?: number;
}

/**
 * Load a platform's candidate tokens as {token, displayName} pairs.
 * Paylocity's dataset carries a real company name alongside each GUID
 * (`{guid, name, jobs}[]`, unlike every other platform's flat `string[]`),
 * so that's used directly instead of title-casing the GUID, which would
 * otherwise produce something unreadable like "4C0Bba55 9Bc2...".
 */
function loadCandidates(platform: Platform): Candidate[] {
  const tokenFile = path.join(DISCOVERY_DIR, `${platform}_tokens.json`);
  const raw = JSON.parse(readFileSync(tokenFile, "utf-8"));

  if (platform === "paylocity") {
    return (raw as PaylocityTokenEntry[])
      .filter((entry) => entry.guid && entry.name)
      .map((entry) => ({ token: entry.guid, displayName: entry.name.trim() }));
  }

  const tokens = raw as string[];
  if (platform === "workday") {
    // Title-casing the whole "tenant|wd1|site" token produced names like
    // "Duckcreek|wd1|duckcreekcareers". The tenant alone is the stand-in
    // here; main() swaps in the real hiringOrganization name when a board
    // actually gets added (see fetchWorkdayCompanyName).
    return tokens.map((token) => ({ token, displayName: titleCaseToken(token.split("|")[0]) }));
  }
  if (platform === "icims") {
    return tokens.map((token) => ({ token, displayName: titleCaseToken(stripIcimsPrefix(token)) }));
  }
  return tokens.map((token) => ({ token, displayName: titleCaseToken(token) }));
}

async function fetchPlatform(
  platform: Platform,
  boards: string[],
): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  const options = { boards, limit: 1 }; // limit: 1 -- discovery only needs to know "does this board have >=1 PM role", not every posting
  switch (platform) {
    case "greenhouse":
      return searchGreenhouse("", options);
    case "ashby":
      return searchAshby("", options);
    case "lever":
      return searchLever("", options);
    case "bamboohr":
      return searchBambooHr("", options);
    case "workday":
      return searchWorkday("", options);
    case "paylocity":
      return searchPaylocity("", options);
    case "icims":
      return searchIcims("", options);
  }
}

async function main() {
  const csvText = readFileSync(COMPANIES_CSV_PATH, "utf-8");
  const existingRows = parseCompaniesCsv(csvText);

  const existingKeys = new Set(existingRows.map((r) => `${r.platform}:${r.token.toLowerCase()}`));

  const platforms: Platform[] = ["greenhouse", "ashby", "lever", "bamboohr", "workday", "paylocity", "icims"];

  let totalCandidates = 0;
  let totalAlreadyKnown = 0;
  let totalAdded = 0;
  let totalNoPmRole = 0;
  let totalFailed = 0;

  const newLines: string[] = [];
  const nowIso = () => new Date().toISOString();

  for (const platform of platforms) {
    const allCandidates = loadCandidates(platform);
    totalCandidates += allCandidates.length;

    const displayNameByToken = new Map(allCandidates.map((c) => [c.token, c.displayName]));

    const candidates = allCandidates
      .map((c) => c.token)
      .filter((token) => {
        const known = existingKeys.has(`${platform}:${token.toLowerCase()}`);
        if (known) totalAlreadyKnown += 1;
        return !known;
      });

    console.log(
      `\n[${platform}] ${allCandidates.length} candidate tokens, ${candidates.length} not already in companies.csv -- checking...`,
    );

    let checked = 0;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const { jobs, meta } = await fetchPlatform(platform, batch);

      totalFailed += meta.boardsFailed.length;

      const pmJobsByBoard = new Map<string, RawJob[]>();
      for (const job of jobs) {
        if (!matchesProductManagerFilter(job.title)) continue;
        const list = pmJobsByBoard.get(job.board) ?? [];
        list.push(job);
        pmJobsByBoard.set(job.board, list);
      }

      for (const board of meta.boardsChecked) {
        const pmJobs = pmJobsByBoard.get(board) ?? [];
        if (pmJobs.length === 0) {
          totalNoPmRole += 1;
          continue;
        }
        const fallbackName = displayNameByToken.get(board) ?? titleCaseToken(board);
        const name =
          platform === "workday" ? ((await fetchWorkdayCompanyName(board)) ?? fallbackName) : fallbackName;
        newLines.push(
          `${csvField(name)},${csvField(board)},${platform},verified,${nowIso()},Auto-discovered (bulk token scan)\r\n`,
        );
        totalAdded += 1;
      }

      checked += batch.length;
      if (checked % (BATCH_SIZE * 20) === 0 || checked === candidates.length) {
        console.log(
          `  [${platform}] checked ${checked}/${candidates.length} (${totalAdded} added so far this run)`,
        );
      }

      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  if (newLines.length > 0) {
    appendFileSync(COMPANIES_CSV_PATH, newLines.join(""));
  }

  console.log(
    `\nDiscovery complete: ${totalCandidates} candidate tokens (${totalAlreadyKnown} already known), ` +
      `${totalAdded} new companies added, ${totalNoPmRole} resolved but have no PM role right now, ` +
      `${totalFailed} didn't resolve at all.`,
  );
  console.log(`companies.csv grew by ${totalAdded} rows. Run npm run sync next to pull in their postings.`);
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exitCode = 1;
});
