/**
 * sources/lever.ts
 * Pulls live job listings directly from individual companies' Lever job
 * boards, the same per-company pattern as greenhouse.ts and ashby.ts.
 * Ported from Maester's sources/lever.py. Lever's public API is one call
 * per company, no auth required:
 *
 *   GET https://api.lever.co/v0/postings/{company}?mode=json
 *
 * Docs: https://github.com/lever/postings-api
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import { extractSalary } from "../extract.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const LEVER_URL = "https://api.lever.co/v0/postings/{company}";

interface LeverJobList {
  text?: string;
  content?: string;
}

interface LeverJob {
  id: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number | string;
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  lists?: LeverJobList[];
  categories?: { location?: string; department?: string; team?: string };
  salaryRange?: { min?: number; max?: number; currency?: string };
}

/**
 * Fetch all postings from one company's Lever board. Returns [] on any
 * failure rather than throwing. Retries once on timeout/abort before giving
 * up — some Lever boards return very large payloads that intermittently
 * exceed the timeout even though the board is genuinely live; a single
 * retry avoids permanently treating a real, working company as failed.
 */
async function fetchBoard(boardToken: string, timeoutMs = 15000): Promise<LeverJob[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(LEVER_URL.replace("{company}", boardToken));
      url.searchParams.set("mode", "json");
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) return [];
      const data = await resp.json();
      // Lever returns a bare JSON array, not a wrapped object like
      // Greenhouse/Ashby — an unexpected shape (e.g. an error page that
      // still returned 200) means treat it as no postings found.
      return Array.isArray(data) ? (data as LeverJob[]) : [];
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return [];
    }
  }
  return [];
}

/**
 * Lever splits content across description + descriptionPlain + a `lists`
 * array of extra sections (Responsibilities, Requirements, etc.) — join all
 * of it so extraction (salary) sees the complete JD, not just the intro
 * paragraph.
 */
function fullDescription(job: LeverJob): string {
  const parts: string[] = [];
  const intro = job.descriptionPlain || stripHtml(job.description);
  if (intro) parts.push(intro);
  for (const section of job.lists ?? []) {
    const sectionTitle = section.text ?? "";
    const sectionContent = stripHtml(section.content);
    if (sectionContent) {
      parts.push(sectionTitle ? `${sectionTitle}: ${sectionContent}` : sectionContent);
    }
  }
  const additional = job.additionalPlain || stripHtml(job.additional);
  if (additional) parts.push(additional);
  return parts.filter(Boolean).join("\n\n");
}

function salaryFromCategories(job: LeverJob): string {
  const range = job.salaryRange ?? {};
  const lo = range.min;
  const hi = range.max;
  const currency = range.currency ?? "USD";
  if (lo && hi) {
    return `${currency} ${lo.toLocaleString("en-US")} - ${hi.toLocaleString("en-US")}`;
  }
  return "";
}

/**
 * Pull postings from each board in `boards`, filter by `query` words
 * appearing in the title, then apply include/exclude title logic.
 */
export async function searchLever(
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

  const rawByBoard = new Map<string, LeverJob[]>();
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
      const title = job.text ?? "";
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

      const categories = job.categories ?? {};
      const location = categories.location ?? "";
      const description = fullDescription(job);
      const salary = salaryFromCategories(job) || extractSalary(description);

      jobs.push({
        id: `lv_${job.id}`,
        title,
        company: board,
        url: job.hostedUrl || job.applyUrl || "",
        location,
        salary,
        category: categories.department || categories.team || "",
        published: job.createdAt != null ? String(job.createdAt) : "",
        description: description.slice(0, 4000),
        source: "lever",
        board,
      });
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed } };
}
