/**
 * sources/ashby.ts
 * Pulls live job listings directly from individual companies' Ashby job
 * boards, the same per-company pattern as greenhouse.ts. Ported from
 * Maester's sources/ashby.py. Ashby's public API is one call per company:
 * api.ashbyhq.com/posting-api/job-board/{board_name}.
 *
 * Docs: https://developers.ashbyhq.com/reference/jobboardapi-jobboard-info
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const ASHBY_URL = "https://api.ashbyhq.com/posting-api/job-board/{board}";

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

async function fetchBoard(boardToken: string, timeoutMs = 15000): Promise<AshbyJob[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(ASHBY_URL.replace("{board}", boardToken));
    url.searchParams.set("includeCompensation", "true");
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { jobs?: AshbyJob[] };
    return data.jobs ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

  const rawByBoard = new Map<string, AshbyJob[]>();
  await Promise.all(
    boards.map(async (board) => {
      rawByBoard.set(board, await fetchBoard(board));
    }),
  );

  for (const board of boards) {
    const rawJobs = rawByBoard.get(board) ?? [];
    if (rawJobs.length === 0) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);

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

  return { jobs, meta: { boardsChecked, boardsFailed } };
}
