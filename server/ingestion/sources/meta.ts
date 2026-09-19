/**
 * sources/meta.ts
 * Pulls Meta's Product Manager postings from metacareers.com.
 *
 * Like apple.ts, this is a SCRAPER added at the project owner's explicit
 * request: Meta publishes no jobs API, and metacareers.com/robots.txt says
 * automated collection is prohibited without Meta's written permission.
 * It makes the same requests the job search page itself makes, and
 * nothing more: it loads the search page, reads the anti-CSRF token
 * ("LSD") and query id the page ships with, and calls Meta's GraphQL
 * endpoint with them. No headless browser and nothing to get around bot
 * protection -- if Meta starts refusing these requests, the board fails and
 * its existing roles are left untouched.
 *
 * The results query (CareersJobSearchResultsDataQuery) takes a
 * search_input with a free-text `q` and returns EVERY match in one
 * response (page 2 repeats page 1), each as { id, title, locations[],
 * teams[], sub_teams[] } -- no description, salary, or posting date. The
 * search is loose ("product manager" matches ~470 postings, most of them
 * not PM roles); sync.ts's PM filter does the real classification as
 * usual. Meta titles PM roles both ways ("Product Manager, Ads" and
 * "Product Management, Director"), so both phrases are searched and
 * merged. Either one alone found all ~30 PM roles when checked.
 *
 * The query id changes whenever Meta redeploys, so it's read from the
 * page's own JS bundles each sync, with the last known id as a fallback.
 *
 * Only the one board token "meta" is valid.
 */

import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const META_BOARD = "meta";
const SEARCH_PAGE_URL = "https://www.metacareers.com/jobsearch/";
const GRAPHQL_URL = "https://www.metacareers.com/graphql";
const JOB_URL = "https://www.metacareers.com/jobs/{id}/";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const REQUEST_DELAY_MS = 1500;
const QUERY_NAME = "CareersJobSearchResultsDataQuery";
const FALLBACK_DOC_ID = "27506805582236862"; // as of 2026-09-19
const SEARCH_PHRASES = ["product manager", "product management"];

// Without Accept headers the search page answers HTTP 400.
const PAGE_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

interface MetaJob {
  id: string;
  title?: string;
  locations?: string[];
  teams?: string[];
  sub_teams?: string[];
}

interface Session {
  lsd: string;
  cookies: string;
  docId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The results query's id, from the JS bundles the search page loads
 * (`__d("CareersJobSearchResultsDataQuery_candidate_portalRelayOperation",
 * ...a.exports="<id>")`). Falls back to the last known id if no bundle has
 * it -- a wrong id then shows up as a failed board, not bad data.
 */
async function findDocId(html: string): Promise<string> {
  const bundleUrls = [
    ...new Set(
      [...html.matchAll(/https:\\?\/\\?\/static\.xx\.fbcdn\.net\\?\/rsrc\.php\\?\/[^"]+?\.js[^"]*/g)].map((m) =>
        m[0].replace(/\\\//g, "/"),
      ),
    ),
  ];
  const pattern = new RegExp(`__d\\("${QUERY_NAME}_candidate_portalRelayOperation"[\\s\\S]{0,120}?a\\.exports="(\\d+)"`);
  for (const url of bundleUrls) {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp?.ok) continue;
    const id = (await resp.text()).match(pattern)?.[1];
    if (id) return id;
  }
  return FALLBACK_DOC_ID;
}

async function openSession(): Promise<Session | null> {
  const resp = await fetchWithTimeout(SEARCH_PAGE_URL, { headers: PAGE_HEADERS });
  if (!resp?.ok) return null;
  const html = await resp.text();
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  if (!lsd) return null;
  const cookies = resp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { lsd, cookies, docId: await findDocId(html) };
}

async function searchJobs(session: Session, q: string): Promise<MetaJob[] | null> {
  const searchInput = {
    q,
    divisions: [],
    offices: [],
    roles: [],
    leadership_levels: [],
    saved_jobs: [],
    saved_searches: [],
    sub_teams: [],
    teams: [],
    is_leadership: false,
    is_remote_only: false,
    sort_by_new: false,
    page: 1,
  };
  const body = new URLSearchParams({
    lsd: session.lsd,
    doc_id: session.docId,
    variables: JSON.stringify({ search_input: searchInput, isLoggedIn: false, viewasUserID: null }),
    fb_api_req_friendly_name: QUERY_NAME,
  });
  const resp = await fetchWithTimeout(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-LSD": session.lsd,
      "X-FB-Friendly-Name": QUERY_NAME,
      Origin: "https://www.metacareers.com",
      Referer: SEARCH_PAGE_URL,
      Cookie: session.cookies,
    },
    body,
  });
  if (!resp?.ok) return null;
  try {
    // The response can carry extra newline-separated payloads after the
    // first JSON object; only the first holds the query result.
    const json = JSON.parse((await resp.text()).split("\n")[0]) as {
      data?: { job_search_with_featured_jobs?: { all_jobs?: MetaJob[] } };
      errors?: unknown;
    };
    const jobs = json.data?.job_search_with_featured_jobs?.all_jobs;
    return json.errors || !Array.isArray(jobs) ? null : jobs;
  } catch {
    return null;
  }
}

/**
 * All-or-nothing, like apple.ts: if either phrase search fails, the whole
 * board fails, so sync.ts never closes roles only the failed search found.
 */
async function fetchBoard(): Promise<{ jobs: MetaJob[]; failed: boolean }> {
  const session = await openSession();
  if (!session) return { jobs: [], failed: true };
  const byId = new Map<string, MetaJob>();
  for (const phrase of SEARCH_PHRASES) {
    await sleep(REQUEST_DELAY_MS);
    const jobs = await searchJobs(session, phrase);
    if (!jobs) return { jobs: [], failed: true };
    for (const job of jobs) byId.set(job.id, job);
  }
  return { jobs: [...byId.values()], failed: false };
}

function normalizeJob(job: MetaJob): RawJob {
  return {
    id: `mt_${job.id}`,
    title: job.title ?? "",
    company: META_BOARD,
    url: JOB_URL.replace("{id}", job.id),
    // Already "Menlo Park, CA" / "London, UK"; several offices joined with
    // "; ", which locationParser splits into one pin per US office.
    location: (job.locations ?? []).join("; "),
    salary: "", // not in the search results
    category: [...(job.teams ?? []), ...(job.sub_teams ?? [])].join(" / "),
    published: "", // not in the search results
    description: "",
    source: "meta",
    board: META_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["meta"]. */
export async function searchMeta(
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
    if (board !== META_BOARD) {
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
