/**
 * sources/booking.ts
 * Pulls Booking.com's Product Manager postings from jobs.booking.com.
 *
 * The careers site is a Jibe deployment (postings come from Booking's
 * iCIMS, but its tenant isn't one icims.ts can list). Jibe serves the
 * site's search as keyless JSON at /api/jobs, with full descriptions and a
 * structured location per posting. robots.txt allows everything with a
 * 5-second crawl delay, which is honoured between pages -- in practice one
 * page covers it (~90 matches for "product manager", 100 per page).
 *
 * Most of these roles are in Amsterdam; non-US ones fall out at geocoding
 * like any other source's.
 *
 * Only the one board token "booking" is valid.
 */

import { stripHtml } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const BOOKING_BOARD = "booking";
const SEARCH_URL = "https://jobs.booking.com/api/jobs";
const JOB_URL = "https://jobs.booking.com/booking/jobs/{slug}";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const CRAWL_DELAY_MS = 5000; // robots.txt crawl-delay: 5

interface JibeJob {
  slug?: string;
  req_id?: string;
  title?: string;
  description?: string;
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  full_location?: string;
  posted_date?: string;
  category?: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(page: number, timeoutMs = 30000): Promise<{ total: number; jobs: JibeJob[] } | null> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keywords", "product manager");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_SIZE));

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = (await resp.json()) as { totalCount?: number; jobs?: Array<{ data?: JibeJob }> };
      if (!Array.isArray(body.jobs)) return null;
      return { total: body.totalCount ?? 0, jobs: body.jobs.map((j) => j.data ?? {}) };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) {
        await sleep(CRAWL_DELAY_MS);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Every posting the search returns, or `failed: true` if any page couldn't be read (see apple.ts for why all-or-nothing). */
async function fetchBoard(): Promise<{ jobs: JibeJob[]; failed: boolean }> {
  const bySlug = new Map<string, JibeJob>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(CRAWL_DELAY_MS);
    const result = await fetchPage(page);
    if (!result) return { jobs: [], failed: true };
    for (const job of result.jobs) if (job.slug) bySlug.set(job.slug, job);
    if (result.jobs.length < PAGE_SIZE || page * PAGE_SIZE >= result.total) break;
  }
  return { jobs: [...bySlug.values()], failed: false };
}

function locationOf(job: JibeJob): string {
  // US postings as "City, ST" so locationParser treats them like every
  // other source's; elsewhere the site's own "City, Country".
  if (job.country_code === "US" && job.city) return job.state ? `${job.city}, ${job.state}` : job.city;
  return job.full_location ?? [job.city, job.country].filter(Boolean).join(", ");
}

function normalizeJob(job: JibeJob): RawJob {
  const slug = job.slug ?? "";
  return {
    id: `bk_${job.req_id ?? slug}`,
    title: job.title ?? "",
    company: BOOKING_BOARD,
    url: JOB_URL.replace("{slug}", slug),
    location: locationOf(job),
    salary: "",
    category: (job.category ?? []).map((c) => c.trim()).join(", "),
    published: job.posted_date ? new Date(Date.parse(job.posted_date.replace(/\+0000$/, "Z"))).toISOString() : "",
    description: stripHtml(job.description).slice(0, 4000),
    source: "booking",
    board: BOOKING_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["booking"]. */
export async function searchBooking(
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
    if (board !== BOOKING_BOARD) {
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
