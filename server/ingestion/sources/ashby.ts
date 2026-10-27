/**
 * sources/ashby.ts
 * Pulls live job listings directly from individual companies' Ashby job
 * boards, the same per-company pattern as greenhouse.ts. Ported from
 * Maester's sources/ashby.py. Ashby's public API is one call per company:
 * api.ashbyhq.com/posting-api/job-board/{board_name}.
 *
 * Docs: https://developers.ashbyhq.com/reference/jobboardapi-jobboard-info
 *
 * Some companies switch that public API off (Whatnot): it answers 404 even
 * though jobs.ashbyhq.com/{board} is live. For those, the board page's own
 * GraphQL endpoint is read instead -- the request the page itself makes.
 * It lists titles, locations and pay but no description; the nightly
 * description step (fetchDescriptions.ts) fills that in.
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const ASHBY_URL = "https://api.ashbyhq.com/posting-api/job-board/{board}";
const ASHBY_GRAPHQL_URL = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams";
const BOARD_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings { id title locationName secondaryLocations { locationName } compensationTierSummary }
  }
}`;

/** The board page's own job list, for boards whose public API is switched off. */
async function fetchBoardFromPage(boardToken: string, timeoutMs: number): Promise<{ jobs: AshbyJob[]; failed: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ASHBY_GRAPHQL_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: "ApiJobBoardWithTeams", variables: { organizationHostedJobsPageName: boardToken }, query: BOARD_QUERY }),
    });
    if (!resp.ok) return { jobs: [], failed: true };
    const data = (await resp.json()) as {
      data?: { jobBoard?: { jobPostings?: Array<{ id: string; title?: string; locationName?: string; secondaryLocations?: Array<{ locationName?: string }>; compensationTierSummary?: string | null }> } | null };
    };
    const postings = data.data?.jobBoard?.jobPostings;
    // No board at all means a dead token, not an empty board.
    if (!postings) return { jobs: [], failed: true };
    return {
      jobs: postings.map((p) => ({
        id: p.id,
        title: p.title?.trim(),
        jobUrl: `https://jobs.ashbyhq.com/${boardToken}/${p.id}`,
        location: [p.locationName, ...(p.secondaryLocations ?? []).map((l) => l.locationName)].filter(Boolean).join("; "),
        compensation: p.compensationTierSummary ? { compensationTierSummary: p.compensationTierSummary } : undefined,
      })),
      failed: false,
    };
  } catch {
    return { jobs: [], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

interface AshbyJob {
  id: string;
  title?: string;
  jobUrl?: string;
  applyUrl?: string;
  location?: string;
  department?: string;
  team?: string;
  publishedAt?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string; summaryComponents?: unknown };
}

/**
 * Fetch all postings from one company's Ashby board. Never throws --
 * returns `failed: true` for anything that means "couldn't tell what's on
 * this board" (network error, timeout, non-2xx response), and `failed:
 * false` with an empty `jobs` array for a board that loaded fine but
 * genuinely has zero current postings, so a dead token isn't confused with
 * a real company that has nothing open right now.
 *
 * Retries once on timeout/abort/network error before giving up, mirroring
 * lever.ts's existing retry-once behavior.
 */
async function fetchBoard(boardToken: string, timeoutMs = 15000): Promise<{ jobs: AshbyJob[]; failed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(ASHBY_URL.replace("{board}", boardToken));
      url.searchParams.set("includeCompensation", "true");
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.status === 404) return fetchBoardFromPage(boardToken, timeoutMs);
      if (!resp.ok) return { jobs: [], failed: true };
      const data = (await resp.json()) as { jobs?: AshbyJob[] };
      return { jobs: data.jobs ?? [], failed: false };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return { jobs: [], failed: true };
    }
  }
  return { jobs: [], failed: true };
}

/**
 * Ashby sometimes returns a structured compensation summary when
 * includeCompensation=true is passed. "" if absent — the caller falls back
 * to regex extraction on the description next.
 */
function compensationToSalary(job: AshbyJob): string {
  const comp = job.compensation ?? {};
  const summary = comp.compensationTierSummary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return "";
}

function normalizeJob(job: AshbyJob, board: string): RawJob {
  const fullDescription = stripHtml(job.descriptionHtml);
  const salary = compensationToSalary(job) || extractSalary(fullDescription);
  return {
    id: `ab_${job.id}`,
    title: job.title ?? "",
    company: board,
    url: job.jobUrl || job.applyUrl || "",
    location: job.location ?? "",
    salary,
    category: job.department || job.team || "",
    published: job.publishedAt ?? "",
    description: fullDescription.slice(0, 4000),
    source: "ashby",
    board,
  };
}

/**
 * Pull postings from each board in `boards`, filter by `query` words
 * appearing in the title, then apply include/exclude title logic.
 */
export async function searchAshby(
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

  const rawByBoard = new Map<string, { jobs: AshbyJob[]; failed: boolean }>();
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
      const title = job.title ?? "";
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

      jobs.push(normalizeJob(job, board));
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
