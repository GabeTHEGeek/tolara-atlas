/**
 * sources/bamboohr.ts
 * Pulls live job listings directly from individual companies' BambooHR
 * careers pages. BambooHR has no documented public API (unlike Greenhouse/
 * Ashby/Lever), but every tenant's careers page is backed by a keyless JSON
 * endpoint the page itself calls client-side:
 *
 *   GET https://{token}.bamboohr.com/careers/list
 *   -> { meta: { totalCount }, result: [{ id, jobOpeningName, departmentLabel,
 *        location: { city, state }, atsLocation: { city, state, country }, ... }] }
 *
 * Confirmed by inspecting a live tenant's network traffic (fullbay.bamboohr.com),
 * not from BambooHR's own docs -- there aren't any. Treat this as a
 * best-effort integration: BambooHR could change this shape without notice,
 * same risk every scraped (vs. documented) endpoint carries.
 *
 * Unlike Greenhouse, the list endpoint does NOT include a job description --
 * that requires a second call per job (GET .../careers/{id}/detail). Fetching
 * every board's full posting list already means one request per company;
 * fetching every individual posting's detail too would mean one request per
 * JOB, with no bulk endpoint to fall back to. That's a lot of extra load for
 * a field (salary, parsed from free-text descriptions) that most boards don't
 * even include -- so this adapter deliberately leaves `description`/`salary`
 * empty rather than doing the N+1 fetch. Title-based PM filtering and
 * location-based geocoding, the two things sync.ts and geocode.ts actually
 * need from this source, both work fine off the list endpoint alone.
 */

import { normalizeTitle, titleMatchesQueryWord } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const BAMBOOHR_LIST_URL = "https://{token}.bamboohr.com/careers/list";

interface BambooHrJob {
  id: string;
  jobOpeningName?: string;
  departmentLabel?: string;
  employmentStatusLabel?: string;
  location?: { city?: string | null; state?: string | null };
  atsLocation?: { city?: string | null; state?: string | null; country?: string | null };
  isRemote?: boolean | null;
}

/**
 * Fetch all postings from one company's BambooHR careers page. Never throws
 * -- returns `failed: true` for anything that means "couldn't tell what's on
 * this board" (network error, timeout, non-2xx response, or a tenant
 * subdomain that doesn't exist at all), and `failed: false` with an empty
 * `jobs` array for a board that loaded fine but genuinely has zero current
 * postings, mirroring greenhouse.ts/ashby.ts/lever.ts so a dead token isn't
 * confused with a real company with nothing open.
 *
 * Retries once on timeout/abort/network error before giving up, same as the
 * other three adapters.
 */
async function fetchBoard(boardToken: string, timeoutMs = 15000): Promise<{ jobs: BambooHrJob[]; failed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = BAMBOOHR_LIST_URL.replace("{token}", boardToken);
      const resp = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      clearTimeout(timer);
      if (!resp.ok) return { jobs: [], failed: true };
      const data = (await resp.json()) as { result?: BambooHrJob[] };
      return { jobs: data.result ?? [], failed: false };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return { jobs: [], failed: true };
    }
  }
  return { jobs: [], failed: true };
}

/**
 * BambooHR splits location across two objects depending on how the tenant
 * configured the posting: `location` (manually typed) and `atsLocation`
 * (structured, tied to a real place). Prefer whichever actually has a city,
 * falling back to state-only or "Remote" when isRemote is set and neither
 * does.
 */
function jobLocation(job: BambooHrJob): string {
  const loc = job.location ?? {};
  const ats = job.atsLocation ?? {};
  const city = loc.city || ats.city || "";
  const state = loc.state || ats.state || "";
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  if (state) return state;
  if (job.isRemote) return "Remote";
  return "";
}

/**
 * Pull postings from each board in `boards`, filter by `query` words
 * appearing in the title, then apply include/exclude title logic. Same
 * contract as searchGreenhouse/searchAshby/searchLever.
 */
export async function searchBambooHr(
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

  const rawByBoard = new Map<string, { jobs: BambooHrJob[]; failed: boolean }>();
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
      const title = job.jobOpeningName ?? "";
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

      jobs.push({
        id: `bh_${job.id}`,
        title,
        company: board,
        url: `https://${board}.bamboohr.com/careers/${job.id}`,
        location: jobLocation(job),
        salary: "", // see file header -- would require an N+1 detail fetch
        category: job.departmentLabel ?? "",
        published: "",
        description: "", // see file header
        source: "bamboohr",
        board,
      });
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
