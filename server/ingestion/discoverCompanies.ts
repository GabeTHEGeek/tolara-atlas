/**
 * ingestion/discoverCompanies.ts
 * One-time (well, re-runnable) bulk expansion of data/companies.csv, using
 * community-maintained token lists instead of hand-adding companies one at
 * a time. sync.ts only ever checks companies ALREADY in companies.csv --
 * this is what actually grows that list.
 *
 * data/discovery/{greenhouse,ashby,lever,bamboohr}_tokens.json are plain
 * arrays of board-token strings pulled from
 * github.com/Feashliaa/job-board-aggregator (data/ licensed CC BY-NC 4.0 --
 * non-commercial use only; fine for this portfolio project, but revisit
 * before ever monetizing Tolara Scout). They carry no company display names
 * or confirmation that a token is even live -- just candidate slugs scraped
 * from Common Crawl by that project.
 *
 * For each candidate token NOT already in companies.csv, this hits the
 * same live ATS APIs sync.ts uses (via the same searchGreenhouse/
 * searchAshby/searchLever/searchBambooHr adapters, so retry/timeout/failed-
 * vs-empty handling is identical) and keeps only the ones that are both (a) a real,
 * responding board and (b) currently have at least one Product-Manager-
 * classified posting on it right now -- companies.csv is meant to be a
 * verified, currently-relevant list, not 15,000 unconfirmed slugs. A
 * candidate that resolves but has no PM roles today is just skipped, not
 * added as unverified -- it can be picked up in a future discovery run if
 * that changes.
 *
 * No API here exposes a company's real display name from a token alone, so
 * the token itself is title-cased as a readable stand-in (e.g.
 * "sword-health" -> "Sword Health"). Good enough to identify the company on
 * the map and in the UI; worth a manual cleanup pass later for any that
 * read awkwardly.
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
import { matchesProductManagerFilter } from "./filters/productManager.js";
import type { RawJob, SearchMeta } from "./sources/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "..", "data", "companies.csv");
const DISCOVERY_DIR = path.join(__dirname, "..", "..", "data", "discovery");

// Conservative: enough parallelism to move at a reasonable pace without
// hammering a free public API that publishes no rate-limit policy.
const BATCH_SIZE = 25;
const PAUSE_BETWEEN_BATCHES_MS = 300;

type Platform = "greenhouse" | "ashby" | "lever" | "bamboohr";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCaseToken(token: string): string {
  return token
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
  }
}

async function main() {
  const csvText = readFileSync(COMPANIES_CSV_PATH, "utf-8");
  const existingRows = parseCompaniesCsv(csvText);

  const existingKeys = new Set(existingRows.map((r) => `${r.platform}:${r.token.toLowerCase()}`));

  const platforms: Platform[] = ["greenhouse", "ashby", "lever", "bamboohr"];

  let totalCandidates = 0;
  let totalAlreadyKnown = 0;
  let totalAdded = 0;
  let totalNoPmRole = 0;
  let totalFailed = 0;

  const newLines: string[] = [];
  const nowIso = () => new Date().toISOString();

  for (const platform of platforms) {
    const tokenFile = path.join(DISCOVERY_DIR, `${platform}_tokens.json`);
    const allTokens = JSON.parse(readFileSync(tokenFile, "utf-8")) as string[];
    totalCandidates += allTokens.length;

    const candidates = allTokens.filter((token) => {
      const known = existingKeys.has(`${platform}:${token.toLowerCase()}`);
      if (known) totalAlreadyKnown += 1;
      return !known;
    });

    console.log(
      `\n[${platform}] ${allTokens.length} candidate tokens, ${candidates.length} not already in companies.csv -- checking...`,
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
        const name = titleCaseToken(board);
        newLines.push(`${name},${board},${platform},verified,${nowIso()},Auto-discovered (bulk token scan)\r\n`);
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
