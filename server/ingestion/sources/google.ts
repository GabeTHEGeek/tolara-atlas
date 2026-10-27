/**
 * sources/google.ts
 * Pulls Google's US product manager postings from google.com/about/careers.
 *
 * Google runs its own careers site, with no public API. Each search results
 * page is server-rendered with the page's postings embedded as JSON in an
 * AF_initDataCallback({key: 'ds:1', ...}) script block: id, title, the
 * about / responsibilities / qualifications HTML (the about section carries
 * the "US: $163000 - $236000 (USD)" pay line), offices and timestamps. So a
 * search is read 20 postings per page, paged until the reported total.
 *
 * The search is scoped server-side to "product manager" in the United
 * States -- Google has many thousands of postings worldwide and only the PM
 * ones matter here. The fuzzy search still returns plenty of non-PM titles
 * (partner managers, TPMs), which the PM filter drops after sync.
 *
 * Note: google.com/robots.txt disallows /about/careers/applications/jobs/
 * results. The owner chose to read it anyway; requests are kept slow and
 * few (about nine pages per night, two seconds apart).
 *
 * Only the one board token "google" is valid.
 */

import { stripHtml } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const GOOGLE_BOARD = "google";
const RESULTS_URL = "https://www.google.com/about/careers/applications/jobs/results";
const SEARCH_QUERY = '"product manager"';
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_DELAY_MS = 2000;
const MAX_PAGES = 30;

// One posting, as the positional array the page embeds. Only the indexes
// read below are typed; the rest are unused.
type GoogleJob = [
  string, // 0 id
  string, // 1 title
  string, // 2 apply URL
  [unknown, string] | null, // 3 responsibilities HTML
  [unknown, string] | null, // 4 qualifications HTML
  ...unknown[],
];

interface GooglePage {
  jobs: GoogleJob[];
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page: number, timeoutMs = 30000): Promise<GooglePage | null> {
  const params = new URLSearchParams({ q: SEARCH_QUERY, location: "United States" });
  if (page > 1) params.set("page", String(page));
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${RESULTS_URL}?${params}`, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      return parsePage(await resp.text());
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/** The ds:1 block's data is [jobs, null, total, pageSize]. */
function parsePage(html: string): GooglePage | null {
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:1'[\s\S]*?data:([\s\S]*?), sideChannel:/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]) as unknown[];
    if (!Array.isArray(data)) return null;
    return { jobs: (Array.isArray(data[0]) ? data[0] : []) as GoogleJob[], total: typeof data[2] === "number" ? data[2] : 0 };
  } catch {
    return null;
  }
}

const html = (field: unknown): string => (Array.isArray(field) && typeof field[1] === "string" ? field[1] : "");

/** "San Jose, CA, USA" stays as is; the location parser reads the City, ST. */
function locations(field: unknown): string {
  if (!Array.isArray(field)) return "";
  return field.map((loc) => (Array.isArray(loc) && typeof loc[0] === "string" ? loc[0] : "")).filter(Boolean).join("; ");
}

/** [seconds, nanos] -> ISO. */
function isoDate(field: unknown): string {
  return Array.isArray(field) && typeof field[0] === "number" ? new Date(field[0] * 1000).toISOString() : "";
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeJob(job: GoogleJob): RawJob {
  const [id, title] = job;
  const about = stripHtml(html(job[10]));
  // "US: $163000 - $236000 (USD)" -- comma-less, which salary.ts reads.
  const pay = about.match(/US:\s*\$\s?[\d,]+\s*-\s*\$\s?[\d,]+/)?.[0].replace(/^US:\s*/, "") ?? "";
  const description = [about, stripHtml(html(job[3])), stripHtml(html(job[4]))].filter(Boolean).join(" ");
  return {
    id: `go_${id}`,
    title: title ?? "",
    company: GOOGLE_BOARD,
    url: `${RESULTS_URL}/${id}-${slug(title ?? "")}`,
    location: locations(job[9]),
    salary: pay,
    category: "",
    published: isoDate(job[12]),
    description: description.slice(0, 4000),
    source: "google",
    board: GOOGLE_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["google"]. */
export async function searchGoogle(
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
    if (board !== GOOGLE_BOARD) {
      boardsFailed.push(board);
      continue;
    }
    const first = await fetchPage(1);
    if (!first) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    if (first.jobs.length === 0) {
      boardsEmpty.push(board);
      continue;
    }
    const all = [...first.jobs];
    const pages = Math.min(MAX_PAGES, Math.ceil(first.total / first.jobs.length));
    for (let page = 2; page <= pages && all.length < limit; page++) {
      await sleep(PAGE_DELAY_MS);
      const next = await fetchPage(page);
      // A failed page mid-way keeps what was read; the next sync fills in.
      if (!next || next.jobs.length === 0) break;
      all.push(...next.jobs);
    }
    const seen = new Set<string>();
    for (const job of all) {
      if (seen.has(job[0])) continue;
      seen.add(job[0]);
      const titleLower = (job[1] ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(job));
      if (jobs.length >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
