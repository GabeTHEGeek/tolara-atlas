/**
 * sources/tiktok.ts
 * Pulls TikTok's job postings from its own careers site (lifeattiktok.com),
 * which runs on an in-house ATS rather than any vendor we already cover.
 * Like Workday's CXS endpoint, it's the keyless JSON API the careers page
 * itself calls -- no login, cookies, or tokens, just the same headers the
 * page sends -- and lifeattiktok.com/robots.txt only disallows /referral/:
 *
 *   POST https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts
 *   body: { keyword, limit, offset }
 *   -> { code: 0, data: { count, job_post_list: [{ id, title, description,
 *        requirement, city_info: { en_name, parent: { en_name, parent: ... } },
 *        job_category, job_post_info: { min_salary, max_salary, currency } }] } }
 *
 * Unlike every other adapter this is ONE company, not a platform hosting
 * many -- the only valid board token is "tiktok". It's still shaped like
 * the others (boards in, RawJob[] + SearchMeta out) so sync.ts treats it
 * the same way.
 *
 * The keyword search is relevance-ranked and fuzzy ("product manager"
 * returns ~1,600 of ~4,300 postings, and the tail doesn't mention product
 * management at all), so it can't be used to pre-filter to PM roles safely.
 * This pages through the whole board instead, 100 at a time, and leaves
 * PM classification to sync.ts like every other adapter.
 */

import { stripHtml } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const TIKTOK_SEARCH_URL = "https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts";
const TIKTOK_JOB_URL = "https://lifeattiktok.com/search/{id}";
const TIKTOK_BOARD = "tiktok";
const PAGE_SIZE = 100; // confirmed live: the API returns a full 100 per request
const INTER_PAGE_DELAY_MS = 250; // ~43 sequential requests per sync -- keep them spaced out
// Stops a runaway loop if `count` ever came back wrong; ~4,300 postings
// today is 43 pages.
const MAX_PAGES = 100;

// The same headers the careers page's own fetch wrapper sends; without
// them the API answers "invalid request".
const HEADERS = {
  "Content-Type": "application/json",
  "accept-language": "en-US",
  origin: "https://lifeattiktok.com",
  "website-path": "tiktok",
};

interface TikTokLocation {
  en_name?: string | null;
  parent?: TikTokLocation | null;
}

interface TikTokJob {
  id: string;
  title?: string;
  description?: string | null;
  requirement?: string | null;
  city_info?: TikTokLocation | null;
  job_category?: { en_name?: string | null } | null;
  job_post_info?: { min_salary?: number | null; max_salary?: number | null; currency?: string | null } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * city_info is a city -> state -> country chain; flattened to
 * "Los Angeles, California, United States", which locationParser already
 * resolves (and flags "..., Brazil" etc. as explicitly non-US).
 */
function locationFromCityInfo(city: TikTokLocation | null | undefined): string {
  const parts: string[] = [];
  for (let node = city; node; node = node.parent) {
    const name = node.en_name?.trim();
    if (name && !parts.includes(name)) parts.push(name);
  }
  return parts.join(", ");
}

async function fetchPage(offset: number, timeoutMs = 20000): Promise<{ count: number; jobs: TikTokJob[] } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(TIKTOK_SEARCH_URL, {
        method: "POST",
        signal: controller.signal,
        headers: HEADERS,
        body: JSON.stringify({ keyword: "", limit: PAGE_SIZE, offset }),
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = (await resp.json()) as { code?: number; data?: { count?: number; job_post_list?: TikTokJob[] } };
      if (body.code !== 0 || !body.data) return null;
      return { count: body.data.count ?? 0, jobs: body.data.job_post_list ?? [] };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/**
 * Every posting on the board, or `failed: true` if the first page couldn't
 * be read. A later page failing stops paging with what was already
 * fetched, same as workday.ts -- a mostly-read board shouldn't lose
 * everything because one request timed out.
 */
async function fetchBoard(): Promise<{ jobs: TikTokJob[]; failed: boolean }> {
  const jobs: TikTokJob[] = [];
  let total: number | null = null;
  for (let page = 0; page < MAX_PAGES && (total === null || jobs.length < total); page++) {
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS);
    const result = await fetchPage(jobs.length);
    if (!result) {
      if (page === 0) return { jobs: [], failed: true };
      break;
    }
    total = result.count;
    jobs.push(...result.jobs);
    if (result.jobs.length === 0) break;
  }
  return { jobs, failed: false };
}

function salaryFor(job: TikTokJob, description: string): string {
  const info = job.job_post_info;
  if (info?.min_salary != null || info?.max_salary != null) {
    const currency = info.currency || "USD";
    const min = info.min_salary ?? info.max_salary!;
    const max = info.max_salary ?? info.min_salary!;
    const fmt = (n: number) => n.toLocaleString("en-US");
    return min === max ? `${currency} ${fmt(min)}` : `${currency} ${fmt(min)} - ${fmt(max)}`;
  }
  return extractSalary(description);
}

function normalizeJob(job: TikTokJob): RawJob {
  // job_post_info's salary fields have been null on every posting checked,
  // and US postings' pay ranges ("$185600 - $374000 annually") only appear
  // on each job's own page, not in this API -- so salary is usually "",
  // which RawJob allows. Both text fields are still searched in case a
  // posting does mention pay inline.
  const description = stripHtml([job.description, job.requirement].filter(Boolean).join("\n\n"));
  return {
    id: `tt_${job.id}`,
    title: job.title ?? "",
    company: TIKTOK_BOARD,
    url: TIKTOK_JOB_URL.replace("{id}", job.id),
    location: locationFromCityInfo(job.city_info),
    salary: salaryFor(job, description),
    category: job.job_category?.en_name ?? "",
    published: "", // not exposed by the search endpoint
    description: description.slice(0, 4000),
    source: "tiktok",
    board: TIKTOK_BOARD,
  };
}

/**
 * Same contract as the other adapters. `boards` should be ["tiktok"]; any
 * other token is reported as failed rather than silently fetched as
 * TikTok. `query`, when given, is matched against titles client-side.
 */
export async function searchTikTok(
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
    if (board !== TIKTOK_BOARD) {
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
      const titleLower = (job.title ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(job));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
