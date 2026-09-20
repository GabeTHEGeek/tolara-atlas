/**
 * sources/eightfold.ts
 * Pulls postings from careers sites built on Eightfold (Netflix's
 * explore.jobs.netflix.net, among others) through the keyless JSON API the
 * site itself calls:
 *
 *   GET https://{host}/api/apply/v2/jobs?domain={domain}&start=0&num=10
 *   -> { count, positions: [{ id, name, location, locations[], department,
 *        business_unit, t_update }] }
 *
 * /api/apply is explicitly Allow-ed in these sites' robots.txt. Note that
 * not every Eightfold tenant serves it -- NVIDIA's answers "Not authorized"
 * and is synced through its Workday board instead.
 *
 * `token` is "{host}|{domain}" ("explore.jobs.netflix.net|netflix.com"),
 * since the API needs both. The list endpoint returns no descriptions (even
 * with full=true), so roles from here have no focus bullets on the role
 * page -- same as Workday and Meta.
 */

import { normalizeTitle, titleMatchesQueryWord } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const PAGE_SIZE = 10; // the API caps a page at 10 regardless of `num`
const INTER_PAGE_DELAY_MS = 250;
const MAX_PAGES = 120;
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";

interface EightfoldPosition {
  id?: number | string;
  name?: string;
  location?: string;
  locations?: string[];
  department?: string;
  business_unit?: string;
  t_update?: number; // seconds since epoch
}

interface ParsedToken {
  host: string;
  domain: string;
}

function parseToken(token: string): ParsedToken | null {
  const [host, domain] = token.split("|").map((p) => p.trim());
  return host && domain ? { host, domain } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  parsed: ParsedToken,
  start: number,
  timeoutMs = 20000,
): Promise<{ count: number; positions: EightfoldPosition[] } | null> {
  const url =
    `https://${parsed.host}/api/apply/v2/jobs?domain=${encodeURIComponent(parsed.domain)}` +
    `&start=${start}&num=${PAGE_SIZE}&query=&sort_by=relevance`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = (await resp.json()) as { count?: number; positions?: EightfoldPosition[] };
      return { count: body.count ?? 0, positions: body.positions ?? [] };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/**
 * Every posting on the board. `failed: true` only when the FIRST page
 * couldn't be read -- a later page failing stops paging and keeps what was
 * already fetched, as in workday.ts.
 */
async function fetchBoard(token: string, wantCount: number): Promise<{ jobs: EightfoldPosition[]; failed: boolean }> {
  const parsed = parseToken(token);
  if (!parsed) return { jobs: [], failed: true };

  const jobs: EightfoldPosition[] = [];
  let total: number | null = null;
  for (let page = 0; page < MAX_PAGES && jobs.length < wantCount; page++) {
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS);
    const result = await fetchPage(parsed, jobs.length);
    if (!result) {
      if (page === 0) return { jobs: [], failed: true };
      break;
    }
    if (total === null) total = result.count;
    jobs.push(...result.positions);
    if (result.positions.length === 0 || jobs.length >= total) break;
  }
  return { jobs, failed: false };
}

/** "Los Gatos,California,United States of America" -> "Los Gatos, California, United States of America". */
function normalizeLocation(position: EightfoldPosition): string {
  const all = position.locations?.length ? position.locations : [position.location ?? ""];
  return all
    .map((l) => l.split(",").map((part) => part.trim()).filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
}

function normalizeJob(position: EightfoldPosition, token: string, parsed: ParsedToken): RawJob {
  const id = String(position.id ?? "");
  return {
    id: `ef_${id}`,
    title: position.name ?? "",
    company: token,
    url: `https://${parsed.host}/careers/job/${id}?domain=${encodeURIComponent(parsed.domain)}`,
    location: normalizeLocation(position),
    salary: "", // not in the list endpoint
    category: position.department || position.business_unit || "",
    published: position.t_update ? new Date(position.t_update * 1000).toISOString() : "",
    description: "", // not served by this endpoint, even with full=true
    source: "eightfold",
    board: token,
  };
}

/** Same contract as the other adapters; `boards` are "{host}|{domain}" tokens. */
export async function searchEightfold(
  query: string,
  options: SearchOptions = {},
): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  const boards = options.boards ?? [];
  const limit = options.limit ?? 15;
  const queryWords = query.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  const excludeNormalized = (options.excludeTitles ?? []).map(normalizeTitle);
  const includeNormalized = options.requireTitleKeywords ? options.requireTitleKeywords.map(normalizeTitle) : null;

  const jobs: RawJob[] = [];
  const boardsChecked: string[] = [];
  const boardsFailed: string[] = [];
  const boardsEmpty: string[] = [];

  for (const board of boards) {
    const parsed = parseToken(board);
    if (!parsed) {
      boardsFailed.push(board);
      continue;
    }
    const result = await fetchBoard(board, limit);
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
    for (const position of result.jobs) {
      const title = position.name ?? "";
      const titleLower = title.toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleMatchesQueryWord(w, titleLower))) continue;
      const titleNormalized = normalizeTitle(title);
      if (includeNormalized !== null && !includeNormalized.some((ok) => titleNormalized.includes(ok))) continue;
      if (excludeNormalized.some((bad) => titleNormalized.includes(bad))) continue;
      jobs.push(normalizeJob(position, board, parsed));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
