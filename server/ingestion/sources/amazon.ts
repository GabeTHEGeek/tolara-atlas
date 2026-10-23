/**
 * sources/amazon.ts
 * Pulls Amazon's US Product Manager postings from amazon.jobs.
 *
 * amazon.jobs/en/search.json is the keyless JSON the site's own search page
 * calls (robots.txt only disallows /internal). A search for "product
 * manager" in the USA matches ~480 postings, 100 per page, each with full
 * description and qualifications text and a structured location list -- so
 * five requests a sync. Pay bands are not in the search results (only on
 * each posting page), so salary is left blank rather than fetched per role.
 *
 * Amazon's search is loose -- "product manager" also matches program and
 * project managers -- which is fine: sync.ts's PM filter does the real
 * classification as for every other source.
 *
 * Only the one board token "amazon" is valid.
 */

import { stripHtml } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const AMAZON_BOARD = "amazon";
const SEARCH_URL = "https://www.amazon.jobs/en/search.json";
const SITE_URL = "https://www.amazon.jobs";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_DELAY_MS = 1000;

interface AmazonJob {
  id?: string;
  id_icims?: string;
  title?: string;
  job_path?: string;
  city?: string;
  state?: string;
  locations?: string[]; // each a JSON string
  posted_date?: string; // "September 10, 2026"
  job_category?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(offset: number, timeoutMs = 30000): Promise<{ hits: number; jobs: AmazonJob[] } | null> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("base_query", "product manager");
  url.searchParams.set("country", "USA");
  url.searchParams.set("result_limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("sort", "recent");

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = (await resp.json()) as { hits?: number; jobs?: AmazonJob[]; error?: unknown };
      if (data.error || !Array.isArray(data.jobs)) return null;
      return { hits: data.hits ?? 0, jobs: data.jobs };
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
async function fetchBoard(): Promise<{ jobs: AmazonJob[]; failed: boolean }> {
  const byId = new Map<string, AmazonJob>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(REQUEST_DELAY_MS);
    const result = await fetchPage(page * PAGE_SIZE);
    if (!result) return { jobs: [], failed: true };
    for (const job of result.jobs) byId.set(job.id_icims ?? job.id ?? "", job);
    if (result.jobs.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= result.hits) break;
  }
  byId.delete("");
  return { jobs: [...byId.values()], failed: false };
}

/** "Seattle, WA; Arlington, VA" from the structured list, falling back to the posting's primary city. */
function locationOf(job: AmazonJob): string {
  const places = (job.locations ?? []).flatMap((raw) => {
    try {
      const l = JSON.parse(raw) as { normalizedCityName?: string; city?: string; region?: string; countryIso2a?: string; type?: string };
      const city = l.normalizedCityName ?? l.city;
      if (!city) return l.type === "REMOTE" ? ["Remote"] : [];
      return [l.region ? `${city}, ${l.region}` : city];
    } catch {
      return [];
    }
  });
  if (places.length === 0 && job.city) places.push(job.state ? `${job.city}, ${job.state}` : job.city);
  return [...new Set(places)].join("; ");
}

function isoDate(posted: string | undefined): string {
  if (!posted) return "";
  const ms = Date.parse(`${posted} UTC`);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

function normalizeJob(job: AmazonJob): RawJob {
  const id = job.id_icims ?? job.id ?? "";
  const description = stripHtml(
    [job.description, job.basic_qualifications && `Basic qualifications: ${job.basic_qualifications}`, job.preferred_qualifications && `Preferred qualifications: ${job.preferred_qualifications}`]
      .filter(Boolean)
      .join(" "),
  );
  return {
    id: `az_${id}`,
    title: job.title ?? "",
    company: AMAZON_BOARD,
    url: job.job_path ? `${SITE_URL}${job.job_path}` : `${SITE_URL}/en/jobs/${id}`,
    location: locationOf(job),
    salary: "", // only on each posting's own page -- not fetched
    category: job.job_category ?? "",
    published: isoDate(job.posted_date),
    description: description.slice(0, 4000),
    source: "amazon",
    board: AMAZON_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["amazon"]. */
export async function searchAmazon(
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
    if (board !== AMAZON_BOARD) {
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
