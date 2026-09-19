/**
 * ingestion/discoverA16z.ts
 * Grows data/companies.csv from a16z's portfolio job board
 * (jobs.a16z.com), the same way discoverCompanies.ts grows it from bulk
 * token lists -- except here every candidate comes with a real company
 * name and is a known a16z portfolio company.
 *
 * jobs.a16z.com is an aggregator, not an ATS: every posting's apply_url
 * points back at the company's own Greenhouse/Ashby/Lever/etc. board. So
 * rather than adding a16z as a new sync platform (which would duplicate
 * boards we already pull, and only exposes a truncated first page of
 * postings with no descriptions), this resolves each portfolio company to
 * its underlying ATS board and feeds THAT into companies.csv, where the
 * existing adapters in sync.ts pick it up like any other company.
 *
 * Steps:
 *   1. Read jobs.a16z.com/sitemap.xml for every /jobs/{slug} company page.
 *   2. Fetch each page and decode the server-rendered React payload
 *      (self.__next_f.push chunks), which embeds the company's first page
 *      of postings as JSON, including company_name and apply_url.
 *   3. Map apply_url hosts to one of our supported platforms + board
 *      token, taking the most common board if a company's postings
 *      disagree.
 *   4. For boards not already in companies.csv, verify via the same live
 *      adapters discoverCompanies.ts uses and keep only boards with at
 *      least one PM-classified posting right now -- same bar as the bulk
 *      discovery, so companies.csv stays a currently-relevant list.
 *   5. Hold back, rather than add, any board whose token doesn't resemble
 *      the a16z company name (nameResemblesToken). a16z's own data isn't
 *      always right -- its "Loop" (Loop Crypto) page listed 13 postings
 *      that all applied through Lead Bank's board, which put Lead Bank's
 *      roles on the map under Loop's name. Held-back boards are printed
 *      for a manual look; a legitimate one (e.g. Worldcoin -> "Tools for
 *      Humanity") can be added to companies.csv by hand.
 *
 * Also writes data/discovery/a16z_portfolio.json: every portfolio company
 * and what it resolved to (platform/token, or the unsupported apply host),
 * so it's visible which a16z companies sit on an ATS we don't cover yet.
 *
 * Usage: npm run discover:a16z
 */

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseCompaniesCsv } from "./csv.js";
import { searchGreenhouse } from "./sources/greenhouse.js";
import { searchAshby } from "./sources/ashby.js";
import { searchLever } from "./sources/lever.js";
import { searchBambooHr } from "./sources/bamboohr.js";
import { searchWorkday } from "./sources/workday.js";
import { searchPaylocity } from "./sources/paylocity.js";
import { searchIcims } from "./sources/icims.js";
import { matchesProductManagerFilter } from "./filters/productManager.js";
import type { RawJob, SearchMeta } from "./sources/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "..", "data", "companies.csv");
const PORTFOLIO_JSON_PATH = path.join(__dirname, "..", "..", "data", "discovery", "a16z_portfolio.json");

const A16Z_ORIGIN = "https://jobs.a16z.com";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1)";

// Page fetches are ~400KB of server-rendered HTML each, from a site that
// isn't an API -- keep concurrency low.
const PAGE_BATCH_SIZE = 6;
const VERIFY_BATCH_SIZE = 25;
const PAUSE_BETWEEN_BATCHES_MS = 300;

type Platform = "greenhouse" | "ashby" | "lever" | "bamboohr" | "workday" | "paylocity" | "icims";

interface Board {
  platform: Platform;
  token: string;
}

interface PortfolioEntry {
  slug: string;
  name: string;
  postingsSeen: number;
  board: Board | null;
  unsupportedHost: string | null; // most common apply host when no supported board was found
  nameMismatch: boolean; // board token doesn't resemble the company name -- held back for review, see step 5
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same quoting rule as discoverCompanies.ts -- a16z names are free text and can contain commas. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

async function loadCompanySlugs(): Promise<string[]> {
  const xml = await fetchText(`${A16Z_ORIGIN}/sitemap.xml`);
  if (xml === null) throw new Error("Could not fetch jobs.a16z.com/sitemap.xml");
  const slugs = [...xml.matchAll(/<loc>https:\/\/jobs\.a16z\.com\/jobs\/([^<\/]+)<\/loc>/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/**
 * The page's data lives in `self.__next_f.push([1,"..."])` script chunks --
 * JS string literals holding the React Server Components payload. Decoding
 * each literal with JSON.parse and concatenating gives plain JSON text that
 * company_name/apply_url can be matched out of directly.
 */
function decodeRscPayload(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      parts.push(JSON.parse(m[1]) as string);
    } catch {
      // A chunk that isn't a valid string literal just isn't one we need.
    }
  }
  return parts.join("");
}

function jsonStringsFor(payload: string, key: string): string[] {
  const re = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`, "g");
  const out: string[] = [];
  for (const m of payload.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]) as string);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Map an apply URL to one of our supported platforms and the board token
 * that platform's adapter expects. null for anything else (Rippling,
 * company-hosted career sites, etc.) -- those are reported, not guessed at.
 */
function boardFromApplyUrl(applyUrl: string): Board | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const forParam = url.searchParams.get("for");
    if (forParam) return { platform: "greenhouse", token: forParam.toLowerCase() };
    if (segments[0] && segments[0] !== "embed") return { platform: "greenhouse", token: segments[0].toLowerCase() };
    return null;
  }
  if (host === "jobs.ashbyhq.com" && segments[0]) {
    return { platform: "ashby", token: decodeURIComponent(segments[0]) };
  }
  // jobs.eu.lever.co boards live on a separate API host lever.ts doesn't query.
  if (host === "jobs.lever.co" && segments[0]) {
    return { platform: "lever", token: segments[0].toLowerCase() };
  }
  const bamboo = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (bamboo && bamboo[1] !== "www") {
    return { platform: "bamboohr", token: bamboo[1] };
  }
  // {tenant}.{wdN}.myworkdayjobs.com/[locale/]{site}/job/... -> "tenant|wdN|site",
  // the token shape workday.ts parses.
  const workday = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (workday) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? "") ? segments.slice(1) : segments;
    if (rest[0]) return { platform: "workday", token: `${workday[1]}|${workday[2]}|${rest[0]}` };
    return null;
  }
  const icims = host.match(/^([a-z0-9-]+)\.icims\.com$/);
  if (icims && icims[1] !== "www") {
    return { platform: "icims", token: icims[1] };
  }
  if (host === "recruiting.paylocity.com") {
    const guid = applyUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (guid) return { platform: "paylocity", token: guid[0].toLowerCase() };
  }
  return null;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Filler that shows up in board tokens but not company names (or vice
// versa): "boxinc", "tryjeeves", "stuut-ai", "keycard-labs", "careers".
const TOKEN_FILLER = /^(try|join|get|work(at|with)?)|(inc|hq|ai|labs?|careers?|jobs|app|io|co)$/g;

/**
 * True when a board token plausibly belongs to the named company -- a
 * cheap guard against a16z mislabeling another company's postings, not a
 * real identity check. Matches if the whole normalized name appears in the
 * token (or vice versa), or any 3+ character word of the name appears in
 * the token. Workday tokens compare on tenant and site, not the data center
 * in the middle; Paylocity tokens are GUIDs with nothing to compare, so
 * they always pass.
 */
function nameResemblesToken(name: string, board: Board): boolean {
  if (board.platform === "paylocity") return true;
  const rawToken =
    board.platform === "workday" ? board.token.split("|").filter((_, i) => i !== 1).join(" ") : board.token;
  const token = normalizeForMatch(rawToken);
  const strippedToken = token.replace(TOKEN_FILLER, "");
  const fullName = normalizeForMatch(name);
  if (!token || !fullName) return false;
  if (token.includes(fullName) || fullName.includes(token)) return true;
  if (strippedToken.length >= 3 && fullName.includes(strippedToken)) return true;
  return name
    .split(/[^A-Za-z0-9]+/)
    .map(normalizeForMatch)
    .some((word) => word.length >= 3 && token.includes(word));
}

function mostCommon<T>(items: T[], keyOf: (item: T) => string): T | null {
  const counts = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { item, count: 1 });
  }
  let best: { item: T; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.item ?? null;
}

async function resolveCompany(slug: string): Promise<PortfolioEntry | null> {
  const html = await fetchText(`${A16Z_ORIGIN}/jobs/${slug}`);
  if (html === null) return null;
  const payload = decodeRscPayload(html);

  const name = jsonStringsFor(payload, "company_name")[0] ?? slug;
  const applyUrls = jsonStringsFor(payload, "apply_url");
  const boards = applyUrls.map(boardFromApplyUrl).filter((b): b is Board => b !== null);
  const board = mostCommon(boards, (b) => `${b.platform}:${b.token.toLowerCase()}`);

  let unsupportedHost: string | null = null;
  if (!board && applyUrls.length > 0) {
    const hosts = applyUrls.flatMap((u) => {
      try {
        return [new URL(u).hostname];
      } catch {
        return [];
      }
    });
    unsupportedHost = mostCommon(hosts, (h) => h);
  }

  const trimmedName = name.trim();
  const nameMismatch = board !== null && !nameResemblesToken(trimmedName, board);
  return { slug, name: trimmedName, postingsSeen: applyUrls.length, board, unsupportedHost, nameMismatch };
}

async function fetchPlatform(platform: Platform, boards: string[]): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  // No per-board limit here (unlike discoverCompanies.ts's limit: 1): the
  // adapters cap BEFORE the PM filter runs, so limit: 1 would only ever
  // test a board's first posting.
  const options = { boards, limit: 500 };
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
  const existingRows = parseCompaniesCsv(readFileSync(COMPANIES_CSV_PATH, "utf-8"));
  const existingKeys = new Set(existingRows.map((r) => `${r.platform}:${r.token.toLowerCase()}`));

  const slugs = await loadCompanySlugs();
  console.log(`[a16z] ${slugs.length} portfolio companies in sitemap -- resolving each to its ATS board...`);

  const portfolio: PortfolioEntry[] = [];
  let pagesFailed = 0;
  for (let i = 0; i < slugs.length; i += PAGE_BATCH_SIZE) {
    const batch = slugs.slice(i, i + PAGE_BATCH_SIZE);
    const results = await Promise.all(batch.map(resolveCompany));
    for (const result of results) {
      if (result) portfolio.push(result);
      else pagesFailed += 1;
    }
    const done = Math.min(i + PAGE_BATCH_SIZE, slugs.length);
    if (done % (PAGE_BATCH_SIZE * 20) === 0 || done === slugs.length) {
      console.log(`  resolved ${done}/${slugs.length}`);
    }
    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  writeFileSync(PORTFOLIO_JSON_PATH, JSON.stringify(portfolio, null, 2) + "\n");

  const resolved = portfolio.filter((p) => p.board);
  const noPostings = portfolio.filter((p) => p.postingsSeen === 0);
  const unsupported = portfolio.filter((p) => !p.board && p.postingsSeen > 0);

  const byPlatform = new Map<Platform, Map<string, string>>(); // platform -> token -> display name
  let alreadyKnown = 0;
  const heldBack: PortfolioEntry[] = [];
  for (const entry of resolved) {
    const { platform, token } = entry.board!;
    if (existingKeys.has(`${platform}:${token.toLowerCase()}`)) {
      alreadyKnown += 1;
      continue;
    }
    if (entry.nameMismatch) {
      heldBack.push(entry);
      continue;
    }
    const tokens = byPlatform.get(platform) ?? new Map<string, string>();
    tokens.set(token, entry.name);
    byPlatform.set(platform, tokens);
  }

  const platformCounts = new Map<string, number>();
  for (const entry of resolved) {
    platformCounts.set(entry.board!.platform, (platformCounts.get(entry.board!.platform) ?? 0) + 1);
  }
  console.log(
    `\n[a16z] ${resolved.length} resolved to a supported board (${[...platformCounts].map(([p, n]) => `${p} ${n}`).join(", ")}), ` +
      `${alreadyKnown} of those already in companies.csv; ${unsupported.length} on an unsupported ATS; ` +
      `${noPostings.length} with no postings; ${pagesFailed} pages failed to load.`,
  );

  const hostCounts = new Map<string, number>();
  for (const entry of unsupported) {
    const host = entry.unsupportedHost ?? "unknown";
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }
  const topHosts = [...hostCounts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topHosts.length > 0) {
    console.log(`[a16z] top unsupported apply hosts: ${topHosts.map(([h, n]) => `${h} (${n})`).join(", ")}`);
  }

  if (heldBack.length > 0) {
    console.log(`\n[a16z] held back ${heldBack.length} boards whose token doesn't resemble the a16z company name -- check by hand:`);
    for (const entry of heldBack) {
      console.log(`  ${entry.name} -> ${entry.board!.platform}:${entry.board!.token}  (${A16Z_ORIGIN}/jobs/${entry.slug})`);
    }
  }

  const nowIso = new Date().toISOString();
  const newLines: string[] = [];
  let noPmRole = 0;
  let verifyFailed = 0;

  for (const [platform, tokens] of byPlatform) {
    const candidates = [...tokens.keys()];
    console.log(`\n[${platform}] verifying ${candidates.length} new a16z boards...`);
    for (let i = 0; i < candidates.length; i += VERIFY_BATCH_SIZE) {
      const batch = candidates.slice(i, i + VERIFY_BATCH_SIZE);
      const { jobs, meta } = await fetchPlatform(platform, batch);
      verifyFailed += meta.boardsFailed.length;

      const boardsWithPm = new Set(jobs.filter((j) => matchesProductManagerFilter(j.title)).map((j) => j.board));
      for (const board of meta.boardsChecked) {
        if (!boardsWithPm.has(board)) {
          noPmRole += 1;
          continue;
        }
        const name = tokens.get(board) ?? board;
        newLines.push(
          `${csvField(name)},${csvField(board)},${platform},verified,${nowIso},a16z portfolio (jobs.a16z.com)\r\n`,
        );
      }
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  if (newLines.length > 0) {
    appendFileSync(COMPANIES_CSV_PATH, newLines.join(""));
  }

  console.log(
    `\na16z discovery complete: ${newLines.length} new companies added, ${noPmRole} new boards have no PM role right now, ` +
      `${verifyFailed} didn't resolve, ${heldBack.length} held back for a name check. Portfolio snapshot written to data/discovery/a16z_portfolio.json.`,
  );
  if (newLines.length > 0) {
    console.log(`companies.csv grew by ${newLines.length} rows. Run npm run sync next to pull in their postings.`);
  }
}

main().catch((err) => {
  console.error("a16z discovery failed:", err);
  process.exitCode = 1;
});
