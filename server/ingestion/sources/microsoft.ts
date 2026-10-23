/**
 * sources/microsoft.ts
 * Pulls Microsoft's US Product Manager postings from
 * apply.careers.microsoft.com.
 *
 * Microsoft's careers site runs on Eightfold, but its tenant refuses the
 * /api/apply/v2/jobs list eightfold.ts uses ("Not authorized for PCSX").
 * The site's own search calls /api/pcsx/search instead -- keyless, and
 * explicitly Allow-ed in its robots.txt. A "product manager" search in the
 * United States matches ~420 postings, but the endpoint returns 10 per page
 * whatever `num` asks for, so a sync is ~45 requests. It also rate-limits
 * hard, with no Retry-After: measured at roughly one page per 12s
 * sustained. So pages go 12s apart and a 429 waits a flat 15s and retries
 * the same page -- a growing backoff (30s, 60s, ...) was tried and stalled
 * for 17+ minutes. A sync spends ~9 minutes on this one board.
 *
 * Results carry title, standardized locations ("Redmond, WA, US"),
 * department and posting time -- no description or pay, same as
 * eightfold.ts and workday.ts.
 *
 * Only the one board token "microsoft" is valid.
 */

import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const MICROSOFT_BOARD = "microsoft";
const SEARCH_URL = "https://apply.careers.microsoft.com/api/pcsx/search";
const JOB_URL = "https://apply.careers.microsoft.com/careers/job/{id}";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_SIZE = 10; // fixed by the endpoint
const MAX_PAGES = 80;
const REQUEST_DELAY_MS = 12000;
const RATE_LIMIT_WAIT_MS = 15000;
const MAX_RATE_LIMIT_RETRIES = 8;

interface PcsxPosition {
  id?: number | string;
  name?: string;
  locations?: string[];
  standardizedLocations?: string[];
  department?: string;
  postedTs?: number; // seconds since epoch
  workLocationOption?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(start: number, timeoutMs = 20000): Promise<{ count: number; positions: PcsxPosition[] } | null> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("domain", "microsoft.com");
  url.searchParams.set("query", "product manager");
  url.searchParams.set("location", "United States");
  url.searchParams.set("start", String(start));

  let rateLimited = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (resp.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
        rateLimited += 1;
        await sleep(RATE_LIMIT_WAIT_MS);
        attempt -= 1; // a 429 isn't a failed attempt, just a wait
        continue;
      }
      if (!resp.ok) return null;
      const body = (await resp.json()) as { data?: { count?: number; positions?: PcsxPosition[] } };
      if (!body.data || !Array.isArray(body.data.positions)) return null;
      return { count: body.data.count ?? 0, positions: body.data.positions };
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

/** Every posting the search returns, or `failed: true` if any page couldn't be read (see apple.ts for why all-or-nothing). */
async function fetchBoard(): Promise<{ jobs: PcsxPosition[]; failed: boolean }> {
  const byId = new Map<string, PcsxPosition>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(REQUEST_DELAY_MS);
    const result = await fetchPage(page * PAGE_SIZE);
    if (!result) return { jobs: [], failed: true };
    for (const p of result.positions) if (p.id != null) byId.set(String(p.id), p);
    if (result.positions.length === 0 || (page + 1) * PAGE_SIZE >= result.count) break;
  }
  return { jobs: [...byId.values()], failed: false };
}

/** "Redmond, WA, US" -> "Redmond, WA"; a bare "United States" (remote-eligible) -> "Remote". */
function locationOf(p: PcsxPosition): string {
  const places = (p.standardizedLocations ?? []).map((l) => l.replace(/,\s*US$/, "").trim()).filter(Boolean);
  const cleaned = places.map((l) => (/^(US|United States)$/i.test(l) ? "Remote" : l));
  if (cleaned.length === 0 && p.workLocationOption === "remote") cleaned.push("Remote");
  return [...new Set(cleaned)].join("; ");
}

function normalizeJob(p: PcsxPosition): RawJob {
  const id = String(p.id);
  return {
    id: `ms_${id}`,
    title: p.name ?? "",
    company: MICROSOFT_BOARD,
    url: JOB_URL.replace("{id}", id),
    location: locationOf(p),
    salary: "", // not in search results
    category: p.department ?? "",
    published: p.postedTs ? new Date(p.postedTs * 1000).toISOString() : "",
    description: "", // not in search results
    source: "microsoft",
    board: MICROSOFT_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["microsoft"]. */
export async function searchMicrosoft(
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
    if (board !== MICROSOFT_BOARD) {
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
    for (const p of result.jobs) {
      const titleLower = (p.name ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(p));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
