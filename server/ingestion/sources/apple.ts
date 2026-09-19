/**
 * sources/apple.ts
 * Pulls Apple's US Product Manager postings from jobs.apple.com.
 *
 * Unlike every other source, this one is a SCRAPER: Apple publishes no
 * jobs API, and its Website Terms of Use (linked from jobs.apple.com)
 * prohibit robots/spiders/page-scraping. Added anyway at the project
 * owner's explicit request, knowing that. To keep it a considerate
 * crawler it makes ~15 sequential page requests per sync, 1.5s apart,
 * identifies itself honestly in the User-Agent, and does nothing to get
 * around bot protection -- if Apple starts blocking it, the board just
 * fails and its existing roles are left untouched.
 *
 * Each search page is server-rendered with its results embedded as JSON
 * (window.__staticRouterHydrationData -> loaderData.search.searchResults,
 * 20 per page, plus totalRecords).
 *
 * Apple's plain keyword search is fuzzy -- "product manager" matches
 * ~4,500 US postings, mostly unrelated by page 5 -- but a QUOTED phrase
 * matches exactly ("product manager" -> 66). Apple titles PM roles both
 * ways ("Product Manager, ..." and "Manager, Platform Product
 * Management"), so it runs one quoted search per PM phrase and merges them,
 * rather than paging through all ~4,500.
 *
 * Only the one board token "apple" is valid.
 */

import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const APPLE_BOARD = "apple";
const SEARCH_URL = "https://jobs.apple.com/en-us/search";
const JOB_URL = "https://jobs.apple.com/en-us/details/{id}";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const REQUEST_DELAY_MS = 1500;
const MAX_PAGES_PER_PHRASE = 20; // "product management" is ~7 pages today

// Quoted-phrase searches covering the titles filters/productManager.ts
// accepts. "product manager" and "product management" are the two that
// matter (Apple uses both); the rest are cheap -- one request each when
// they have no or few results.
const SEARCH_PHRASES = [
  "product manager",
  "product management",
  "product owner",
  "product lead",
  "head of product",
  "director of product",
  "product director",
  "product strategist",
];

interface AppleLocation {
  name?: string;
  countryName?: string;
}

interface AppleResult {
  id: string;
  positionId?: string;
  postingTitle?: string;
  jobSummary?: string;
  postingDate?: string;
  team?: { teamName?: string };
  locations?: AppleLocation[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSearchPage(
  phrase: string,
  page: number,
  timeoutMs = 20000,
): Promise<{ total: number; results: AppleResult[] } | null> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("search", `"${phrase}"`);
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("location", "united-states-USA");
  url.searchParams.set("page", String(page));

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const html = await resp.text();
      const match = html.match(/window\.__staticRouterHydrationData = JSON\.parse\(("(?:[^"\\]|\\.)*")\);/);
      if (!match) return null;
      const data = JSON.parse(JSON.parse(match[1]) as string) as {
        loaderData?: { search?: { totalRecords?: number; searchResults?: AppleResult[] } };
      };
      const search = data.loaderData?.search;
      if (!search) return null;
      return { total: search.totalRecords ?? 0, results: search.searchResults ?? [] };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) {
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Every result across all phrase searches, deduplicated by posting id, or
 * `failed: true` if ANY page couldn't be read. Deliberately all-or-nothing
 * (unlike workday.ts/tiktok.ts, which keep partial results): a phrase
 * search that silently dropped out would make sync.ts close every role it
 * alone had found, as if Apple had taken them down.
 */
async function fetchBoard(): Promise<{ jobs: AppleResult[]; failed: boolean }> {
  const byId = new Map<string, AppleResult>();
  let first = true;
  for (const phrase of SEARCH_PHRASES) {
    for (let page = 1; page <= MAX_PAGES_PER_PHRASE; page++) {
      if (!first) await sleep(REQUEST_DELAY_MS);
      first = false;
      const result = await fetchSearchPage(phrase, page);
      if (!result) return { jobs: [], failed: true };
      for (const job of result.results) byId.set(job.id, job);
      if (result.results.length === 0 || page * 20 >= result.total) break;
    }
  }
  return { jobs: [...byId.values()], failed: false };
}

/** "Jul 31, 2026" -> "2026-07-31T00:00:00.000Z"; "" if unparseable. */
function isoDate(postingDate: string | undefined): string {
  if (!postingDate) return "";
  const ms = Date.parse(`${postingDate} UTC`);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

function normalizeJob(job: AppleResult): RawJob {
  // Apple gives a bare office name ("Cupertino", "New York City") with no
  // state; locationParser's known-US-city table resolves those. Several
  // offices are joined with "; ", which it splits into one pin each.
  const location = (job.locations ?? [])
    .map((l) => l.name?.trim())
    .filter((name): name is string => Boolean(name))
    .join("; ");
  return {
    id: `ap_${job.id}`,
    title: job.postingTitle ?? "",
    company: APPLE_BOARD,
    url: JOB_URL.replace("{id}", job.id),
    location,
    salary: "", // pay ranges are only on each job's detail page -- not fetched, to keep request volume low
    category: job.team?.teamName ?? "",
    published: isoDate(job.postingDate),
    description: (job.jobSummary ?? "").slice(0, 4000),
    source: "apple",
    board: APPLE_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["apple"]. */
export async function searchApple(
  query: string,
  options: SearchOptions = {},
): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  const boards = options.boards ?? [];
  const limit = options.limit ?? 15;
  const queryWords = query.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());

  const jobs: RawJob[] = [];
  const boardsChecked: string[] = [];
  const boardsFailed: string[] = [];
  const boardsEmpty: string[] = [];

  for (const board of boards) {
    if (board !== APPLE_BOARD) {
      boardsFailed.push(board);
      continue;
    }
    const result = await fetchBoard();
    if (result.failed) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    if (result.jobs.length === 0) {
      boardsEmpty.push(board);
      continue;
    }
    let kept = 0;
    for (const job of result.jobs) {
      const titleLower = (job.postingTitle ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(job));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
