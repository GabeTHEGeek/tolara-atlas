/**
 * sources/greenhouse.ts
 * Pulls live job listings directly from individual companies' Greenhouse job
 * boards. Ported from Maester's sources/greenhouse.py — same URL patterns,
 * same per-board-cap/parallel-fetch/salary-extraction logic.
 *
 * Unlike an aggregate search endpoint, Greenhouse has no cross-company
 * search — each company has its own board at
 * boards-api.greenhouse.io/v1/boards/{board_token}/jobs. We fetch every
 * posting from each configured board and filter client-side.
 *
 * Docs: https://developers.greenhouse.io/job-board.html
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const GREENHOUSE_URL = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs";

interface GreenhouseJob {
  id: number;
  title?: string;
  location?: { name?: string };
  content?: string;
  absolute_url?: string;
  updated_at?: string;
  pay_input_ranges?: Array<{ min_cents?: number; max_cents?: number; currency_type?: string }>;
}

/**
 * Fetch all postings from one company's Greenhouse board. Returns [] on any
 * failure (bad token, board not on Greenhouse, network issue) rather than
 * throwing, so one dead board doesn't kill a multi-board search.
 */
async function fetchBoard(boardToken: string, timeoutMs = 15000): Promise<GreenhouseJob[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(GREENHOUSE_URL.replace("{board}", boardToken));
    url.searchParams.set("content", "true");
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { jobs?: GreenhouseJob[] };
    return data.jobs ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull postings from each board in `boards`, filter by `query` words
 * appearing in the title, then apply include/exclude title logic.
 *
 * Returns { jobs, meta } where meta = { boardsChecked, boardsFailed } so the
 * caller can see which boards actually returned data.
 */
export async function searchGreenhouse(
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

  // Fetch every board in parallel — network-bound, boards don't depend on
  // each other. Filtering afterward stays sequential (in board order) so
  // results are deterministic.
  const rawByBoard = new Map<string, GreenhouseJob[]>();
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

      const location = job.location?.name ?? "";
      const fullDescription = stripHtml(job.content);

      // Some Greenhouse boards expose a structured pay range (pay-
      // transparency compliance); most don't. Fall back to scanning the
      // FULL description text (before truncation).
      let salary = "";
      const payRanges = job.pay_input_ranges ?? [];
      if (payRanges.length > 0) {
        const r = payRanges[0];
        const lo = r.min_cents;
        const hi = r.max_cents;
        const currency = r.currency_type ?? "USD";
        if (lo && hi) {
          salary = `${currency} ${Math.floor(lo / 100).toLocaleString("en-US")} - ${Math.floor(hi / 100).toLocaleString("en-US")}`;
        }
      }
      if (!salary) {
        salary = extractSalary(fullDescription);
      }

      jobs.push({
        id: `gh_${job.id}`,
        title,
        company: board,
        url: job.absolute_url ?? "",
        location,
        salary,
        category: "",
        published: job.updated_at ?? "",
        description: fullDescription.slice(0, 4000),
        source: "greenhouse",
        board,
      });
      boardJobCount += 1;
      // Per-board cap, not a shared global one — a global cap would starve
      // companies later in iteration order even with plenty of relevant
      // openings.
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed } };
}
