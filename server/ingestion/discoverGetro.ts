/**
 * ingestion/discoverGetro.ts
 * Grows data/companies.csv from VC portfolio job boards that run on Getro
 * (jobs.accel.com, jobs.generalcatalyst.com and others below), the way
 * discoverA16z.ts does for a16z: every candidate is a known portfolio
 * company, and each one is resolved to its own ATS board so sync.ts reads
 * the company directly.
 *
 * Only public pages are read, the same ones a search engine crawls:
 *   1. The board's sitemap.xml points at sitemap_jobs{N}.xml files listing
 *      every posting as /companies/{company}/jobs/{id}-{title-slug}.
 *   2. The title slug says whether a posting is a PM role, so only PM
 *      postings are looked at, at most MAX_JOBS_PER_COMPANY per company.
 *   3. A posting's page embeds its data (__NEXT_DATA__): the company name,
 *      locations and the apply URL, which points at the company's own
 *      Greenhouse/Ashby/Lever/etc. board.
 *   4. Boards we don't already track are verified with the same live
 *      adapters sync.ts uses and kept only if they have a PM role right now;
 *      companies whose PM postings are all outside the US are skipped, and a
 *      board whose token doesn't resemble the company name is held back for
 *      a look by hand (see nameResemblesToken).
 *
 * Boards on Consider (Sequoia, Lightspeed, Bessemer, GV, Kleiner Perkins,
 * Felicis) aren't covered: they publish no sitemap and load jobs only
 * through their own app's API.
 *
 *   npm run discover:vc               # all boards below
 *   npm run discover:vc -- --dry-run  # report what would be added, change nothing
 *   npm run discover:vc -- --board jobs.accel.com
 *
 * Writes data/discovery/getro_portfolios.json: every company seen and what
 * its PM postings resolved to.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseCompaniesCsv } from "./csv.js";
import { matchesProductManagerFilter } from "./filters/productManager.js";
import {
  boardFromApplyUrl,
  csvField,
  fetchPlatform,
  fetchText,
  nameResemblesToken,
  sleep,
  type Board,
  type Platform,
} from "./discoverShared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "..", "data", "companies.csv");
const SNAPSHOT_PATH = path.join(__dirname, "..", "..", "data", "discovery", "getro_portfolios.json");

/** VC job boards confirmed to run on Getro. Add a host here to include it. */
const BOARDS: Array<{ firm: string; host: string }> = [
  { firm: "Accel", host: "jobs.accel.com" },
  { firm: "General Catalyst", host: "jobs.generalcatalyst.com" },
  { firm: "Khosla Ventures", host: "jobs.khoslaventures.com" },
  { firm: "Insight Partners", host: "jobs.insightpartners.com" },
  { firm: "Thrive Capital", host: "jobs.thrivecap.com" },
  { firm: "8VC", host: "jobs.8vc.com" },
];

const MAX_JOBS_PER_COMPANY = 3;
const PAGE_CONCURRENCY = 4;
const PAUSE_BETWEEN_BATCHES_MS = 400;
const VERIFY_BATCH_SIZE = 25;

interface CompanyResult {
  firm: string;
  host: string;
  companySlug: string;
  name: string;
  pmPostings: number;
  usPm: boolean;
  board: Board | null;
  unsupportedHost: string | null;
  nameMismatch: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

const US_PLACE = /United States|\bUSA\b|, (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;

/** PM postings per company, read from the board's job sitemaps. */
async function pmPostingsByCompany(host: string): Promise<Map<string, string[]>> {
  const index = await fetchText(`https://${host}/sitemap.xml`);
  if (index === null) throw new Error(`no sitemap at ${host}`);
  const jobSitemaps = locs(index).filter((u) => /sitemap_jobs\d*\.xml$/.test(u));
  const byCompany = new Map<string, string[]>();
  for (const url of jobSitemaps) {
    const xml = await fetchText(url, 30000);
    if (xml === null) continue;
    for (const loc of locs(xml)) {
      const m = loc.match(/\/companies\/([^/]+)\/jobs\/\d+-([^/?#]+)/);
      if (!m) continue;
      const title = decodeURIComponent(m[2]).replace(/-/g, " ");
      if (!matchesProductManagerFilter(title)) continue;
      const list = byCompany.get(m[1]) ?? [];
      list.push(loc);
      byCompany.set(m[1], list);
    }
    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }
  return byCompany;
}

interface JobPage {
  name: string;
  applyUrl: string | null;
  locations: string[];
}

async function readJobPage(url: string): Promise<JobPage | null> {
  const html = await fetchText(url);
  if (html === null) return null;
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]) as {
      props?: { pageProps?: { initialState?: { jobs?: { currentJob?: Record<string, unknown> | null } } } };
    };
    const job = data.props?.pageProps?.initialState?.jobs?.currentJob;
    if (!job) return null;
    const org = job.organization as { name?: string } | undefined;
    const rawLocations = (job.locations as Array<string | { name?: string }> | undefined) ?? [];
    return {
      name: (org?.name ?? "").trim(),
      applyUrl: typeof job.url === "string" ? job.url : null,
      locations: rawLocations.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
    };
  } catch {
    return null;
  }
}

async function resolveCompany(firm: string, host: string, companySlug: string, jobUrls: string[]): Promise<CompanyResult> {
  const result: CompanyResult = {
    firm,
    host,
    companySlug,
    name: companySlug,
    pmPostings: jobUrls.length,
    usPm: false,
    board: null,
    unsupportedHost: null,
    nameMismatch: false,
  };
  for (const url of jobUrls.slice(0, MAX_JOBS_PER_COMPANY)) {
    const page = await readJobPage(url);
    if (!page) continue;
    // Some boards append a tagline: "Nuitée | Enabling All Companies to Build Travel Solutions".
    if (page.name) result.name = page.name.split(/\s+[|–—]\s+/)[0].trim();
    if (page.locations.length === 0 || page.locations.some((l) => US_PLACE.test(l) || /remote/i.test(l))) result.usPm = true;
    if (!page.applyUrl || result.board) continue;
    const board = boardFromApplyUrl(page.applyUrl);
    if (board) result.board = board;
    else {
      try {
        result.unsupportedHost = new URL(page.applyUrl).hostname;
      } catch {
        // not a URL; leave it
      }
    }
    if (result.board && result.usPm) break;
  }
  result.nameMismatch = result.board !== null && !nameResemblesToken(result.name, result.board);
  return result;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("board");
  const boards = only ? BOARDS.filter((b) => b.host === only) : BOARDS;
  if (boards.length === 0) throw new Error(`Unknown board ${only}. Known: ${BOARDS.map((b) => b.host).join(", ")}`);

  const existing = parseCompaniesCsv(readFileSync(COMPANIES_CSV_PATH, "utf-8"));
  const existingKeys = new Set(existing.map((r) => `${r.platform}:${r.token.toLowerCase()}`));

  const results: CompanyResult[] = [];
  for (const { firm, host } of boards) {
    let byCompany: Map<string, string[]>;
    try {
      byCompany = await pmPostingsByCompany(host);
    } catch (err) {
      console.log(`[${firm}] skipped: ${(err as Error).message}`);
      continue;
    }
    const slugs = [...byCompany.keys()];
    console.log(`[${firm}] ${slugs.length} portfolio companies have PM postings -- reading their job pages...`);
    for (let i = 0; i < slugs.length; i += PAGE_CONCURRENCY) {
      const batch = slugs.slice(i, i + PAGE_CONCURRENCY);
      results.push(...(await Promise.all(batch.map((slug) => resolveCompany(firm, host, slug, byCompany.get(slug)!)))));
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(results, null, 2) + "\n");

  // One candidate per board, across firms (a company backed by two firms appears on both boards).
  const candidates = new Map<string, CompanyResult>();
  let known = 0;
  let nonUs = 0;
  const heldBack: CompanyResult[] = [];
  for (const r of results) {
    if (!r.board) continue;
    const key = `${r.board.platform}:${r.board.token.toLowerCase()}`;
    if (existingKeys.has(key)) {
      known += 1;
      continue;
    }
    if (!r.usPm) {
      nonUs += 1;
      continue;
    }
    if (r.nameMismatch) {
      heldBack.push(r);
      continue;
    }
    if (!candidates.has(key)) candidates.set(key, r);
  }
  const unsupported = new Map<string, number>();
  for (const r of results) if (!r.board && r.unsupportedHost) unsupported.set(r.unsupportedHost, (unsupported.get(r.unsupportedHost) ?? 0) + 1);

  console.log(
    `\n${results.length} companies with PM postings: ${results.filter((r) => r.board).length} on a supported ATS ` +
      `(${known} already tracked, ${nonUs} with only non-US PM roles), ${results.filter((r) => !r.board).length} elsewhere.`,
  );
  const topHosts = [...unsupported].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topHosts.length) console.log(`Most common unsupported apply hosts: ${topHosts.map(([h, n]) => `${h} (${n})`).join(", ")}`);
  if (heldBack.length) {
    console.log(`\nHeld back ${heldBack.length} whose board doesn't look like the company name -- check by hand:`);
    for (const r of heldBack) console.log(`  ${r.name} -> ${r.board!.platform}:${r.board!.token}  (https://${r.host}/companies/${r.companySlug})`);
  }

  // Verify the new boards live, keeping only those with a PM role right now.
  const byPlatform = new Map<Platform, CompanyResult[]>();
  for (const r of candidates.values()) byPlatform.set(r.board!.platform, [...(byPlatform.get(r.board!.platform) ?? []), r]);
  const nowIso = new Date().toISOString();
  const newLines: string[] = [];
  let noPm = 0;
  for (const [platform, list] of byPlatform) {
    console.log(`\n[${platform}] verifying ${list.length} new boards...`);
    for (let i = 0; i < list.length; i += VERIFY_BATCH_SIZE) {
      const batch = list.slice(i, i + VERIFY_BATCH_SIZE);
      const byToken = new Map(batch.map((r) => [r.board!.token, r]));
      const { jobs, meta } = await fetchPlatform(platform, [...byToken.keys()]);
      const withPm = new Set(jobs.filter((j) => matchesProductManagerFilter(j.title)).map((j) => j.board));
      for (const token of meta.boardsChecked) {
        const r = byToken.get(token);
        if (!r) continue;
        if (!withPm.has(token)) {
          noPm += 1;
          continue;
        }
        newLines.push(`${csvField(r.name)},${csvField(token)},${platform},verified,${nowIso},${csvField(`${r.firm} portfolio (${r.host})`)}\n`);
      }
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  if (!dryRun && newLines.length > 0) appendFileSync(COMPANIES_CSV_PATH, newLines.join(""));
  console.log(
    `\n${dryRun ? "Dry run: would add" : "Added"} ${newLines.length} companies` +
      ` (${noPm} new boards had no PM role when checked live, ${heldBack.length} held back).`,
  );
  if (newLines.length) {
    for (const line of newLines.slice(0, 40)) console.log(`  ${line.split(",")[0]}  ${line.split(",")[2]}  ${line.trim().split(",").pop()}`);
    if (newLines.length > 40) console.log(`  ...and ${newLines.length - 40} more`);
  }
  if (!dryRun && newLines.length) console.log("Run npm run sync next to pull in their postings.");
}

main().catch((err) => {
  console.error("VC board discovery failed:", err);
  process.exitCode = 1;
});
