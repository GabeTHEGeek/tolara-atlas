/**
 * sources/paylocity.ts
 * Pulls live job listings directly from individual companies' Paylocity
 * careers pages. Like BambooHR, Paylocity has no documented public API --
 * unlike BambooHR, it doesn't even have an undocumented JSON endpoint. The
 * careers page itself is server-rendered HTML with the full job list
 * embedded as a JS variable assignment in a <script> tag:
 *
 *   GET https://recruiting.paylocity.com/recruiting/jobs/All/{guid}/
 *   -> ...<script>window.pageData = { "Jobs": [...], ... };</script>...
 *
 * (Note the exact casing and trailing slash -- recruiting.paylocity.com is
 * case- and slash-sensitive; a differently-cased or slash-less path serves
 * a client-rendered shell with no data in the raw HTML at all, which is
 * what made this look unworkable on a first pass.) No JS execution needed,
 * just a GET and a regex over the response body -- confirmed against a
 * live tenant with 2,000+ real postings before writing this adapter.
 *
 * Unlike BambooHR, Paylocity's page gives the FULL job list -- including
 * description and structured city/state -- in that one request, no N+1
 * per-job fetch required. It's the most complete of the four ATS sources
 * this project pulls from for that reason.
 *
 * `token` here is the Paylocity tenant GUID (e.g.
 * "4c0bba55-9bc2-4496-8afe-0fff901e9cde"), not a human-chosen slug -- it's
 * meaningless on its own, so discoverCompanies.ts uses the REAL company
 * name that ships alongside each GUID in data/discovery/paylocity_tokens.json
 * instead of title-casing the token like it does for the other platforms.
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const PAYLOCITY_URL = "https://recruiting.paylocity.com/recruiting/jobs/All/{guid}/";
// Lazy match, same as the shape confirmed live: the JSON blob is safely
// terminated by "};</script>" in every tenant checked so far. A job
// description containing that literal substring could in theory truncate
// the match early and fail to parse -- rare enough in practice not to be
// worth a hand-rolled brace-balancing parser for a best-effort integration.
const PAGE_DATA_RE = /window\.pageData\s*=\s*(\{.*?\});\s*<\/script>/s;

interface PaylocityJobLocation {
  City?: string | null;
  State?: string | null;
}

interface PaylocityJob {
  JobId: number;
  JobTitle?: string;
  LocationName?: string | null;
  PublishedDate?: string;
  Description?: string;
  HiringDepartment?: string | null;
  JobLocation?: PaylocityJobLocation | null;
  IsRemote?: boolean;
}

/**
 * Fetch all postings from one company's Paylocity careers page. Never
 * throws -- returns `failed: true` when the page didn't load OR loaded but
 * had no pageData blob to parse (a dead/invalid GUID 302-redirects to a
 * generic "JobNotFound" page that still returns 200, so a missing blob
 * after a 200 is a real failure signal here, not evidence of zero jobs).
 * `failed: false` with an empty `jobs` array is reserved for a blob that
 * parsed fine but genuinely listed no jobs, mirroring the other adapters.
 *
 * Retries once on timeout/abort/network error before giving up, same as
 * the other three adapters.
 */
async function fetchBoard(guid: string, timeoutMs = 20000): Promise<{ jobs: PaylocityJob[]; failed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = PAYLOCITY_URL.replace("{guid}", guid);
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      });
      clearTimeout(timer);
      if (!resp.ok) return { jobs: [], failed: true };
      const html = await resp.text();
      const match = html.match(PAGE_DATA_RE);
      if (!match) return { jobs: [], failed: true };
      const data = JSON.parse(match[1]) as { Jobs?: PaylocityJob[] };
      return { jobs: data.Jobs ?? [], failed: false };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return { jobs: [], failed: true };
    }
  }
  return { jobs: [], failed: true };
}

/** JobLocation carries the real city/state; LocationName is often an internal label ("Main", store number/address) and is only a last-resort fallback. */
function jobLocation(job: PaylocityJob): string {
  const loc = job.JobLocation ?? {};
  if (loc.City && loc.State) return `${loc.City}, ${loc.State}`;
  if (loc.City) return loc.City;
  return job.LocationName ?? "";
}

/**
 * Pull postings from each board (Paylocity tenant GUID) in `boards`, filter
 * by `query` words appearing in the title, then apply include/exclude
 * title logic. Same contract as the other three adapters.
 */
export async function searchPaylocity(
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

  const rawByBoard = new Map<string, { jobs: PaylocityJob[]; failed: boolean }>();
  await Promise.all(
    boards.map(async (board) => {
      rawByBoard.set(board, await fetchBoard(board));
    }),
  );

  for (const board of boards) {
    const result = rawByBoard.get(board) ?? { jobs: [], failed: true };
    if (result.failed) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    const rawJobs = result.jobs;
    if (rawJobs.length === 0) {
      boardsEmpty.push(board);
      continue;
    }

    let boardJobCount = 0;
    for (const job of rawJobs) {
      const title = job.JobTitle ?? "";
      const titleLower = title.toLowerCase();

      if (queryWords.length > 0 && !queryWords.some((w) => titleMatchesQueryWord(w, titleLower))) {
        continue;
      }

      const titleNormalized = normalizeTitle(title);
      if (includeNormalized !== null && !includeNormalized.some((ok) => titleNormalized.includes(ok))) {
        continue;
      }
      if (excludeNormalized.some((bad) => titleNormalized.includes(bad))) {
        continue;
      }

      const description = stripHtml(job.Description);

      jobs.push({
        id: `py_${job.JobId}`,
        title,
        company: board,
        url: `https://recruiting.paylocity.com/recruiting/Jobs/Details/${job.JobId}`,
        location: jobLocation(job),
        salary: extractSalary(description),
        category: job.HiringDepartment ?? "",
        published: job.PublishedDate ?? "",
        description: description.slice(0, 4000),
        source: "paylocity",
        board,
      });
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
