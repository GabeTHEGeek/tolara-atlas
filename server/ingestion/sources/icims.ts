/**
 * sources/icims.ts
 * Pulls live job listings directly from individual companies' iCIMS career
 * portals.
 *
 * iCIMS looked unworkable on a first pass -- the endpoint their own public
 * sitemap.xml sits behind trips a "Human Verification" bot-detection wall on
 * a real fraction of tenants. The actual page a real applicant sees does
 * not: `careers-{tenant}.icims.com/jobs/search?ss=1&in_iframe=1` returns
 * plain server-rendered HTML with the job list inline, no JS execution or
 * verification step, confirmed live against several tenants (some direct,
 * some after a legitimate subdomain-migration redirect). Cross-checked
 * against career-ops-hq's production iCIMS scraper (a real, maintained
 * open-source job aggregator) to confirm the same endpoint, the same
 * `in_iframe=1` parameter, and the same WAF-avoidance rationale, and to
 * correct a couple of assumptions this adapter would otherwise have gotten
 * wrong: pagination is real (`pr=<page>`, ~20/page) and a board's LOCATION
 * is frequently blank on the list page for tenants that don't render it in
 * that field -- career-ops fixes that with a per-job detail-page fetch
 * (JSON-LD `jobLocation`); this adapter doesn't, to stay a single request
 * per board like the other sources here, so an iCIMS role with a blank
 * location just falls through to geocode.ts's remote/office fallback like
 * any other unresolvable-location role, rather than being silently wrong.
 *
 * `token` is the iCIMS subdomain label (everything before ".icims.com") --
 * usually "careers-<slug>" but not always (some tenants use "jobs-<slug>",
 * a country/language prefix like "cacareers-<slug>", or no prefix at all).
 * The community token dataset this project pulls candidates from is
 * inconsistent about which form it recorded, so fetchOrigin tries the token
 * as given first and, if that fails to resolve, retries once with
 * "careers-" prepended (unless the token already starts with it) before
 * giving up -- cheap self-correction that avoids needing to guess the right
 * form up front.
 */

import { normalizeTitle, stripHtml, titleMatchesQueryWord } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ICIMS_MAX_PAGES = 25; // keeps a single board's worst case in line with PER_BOARD_LIMIT (500) elsewhere
const INTER_PAGE_DELAY_MS = 250; // same WAF-courtesy reasoning as workday.ts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// iCIMS content is plain HTML with a handful of named entities -- not full
// HTML, so a tiny fixed table is enough without pulling in an HTML-entity
// library for this one adapter.
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

function searchUrl(origin: string, page: number): string {
  return `${origin}/jobs/search?ss=1&pr=${page}&in_iframe=1`;
}

interface IcimsCard {
  title: string;
  url: string;
  location: string;
  description: string;
  category: string;
}

/**
 * Parse one iCIMS search-results page. Cards are `<li class="iCIMS_JobCardItem">`
 * blocks; splitting the raw HTML on that class name (rather than a proper DOM
 * parse, which this project avoids elsewhere too) is enough since iCIMS's own
 * markup is consistent about it across themed tenants.
 */
function parseSearchPage(html: string, origin: string): IcimsCard[] {
  const cards = html.split("iCIMS_JobCardItem").slice(1);
  const results: IcimsCard[] = [];

  for (const card of cards) {
    const hrefMatch = card.match(/href="([^"]*\/jobs\/\d+\/[^"/]+\/job[^"]*)"/);
    if (!hrefMatch) continue;
    let parsed: URL;
    try {
      parsed = new URL(decodeEntities(hrefMatch[1]), origin);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue; // defense in depth, mirrors career-ops-hq

    const titleMatch = card.match(/<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/);
    if (!titleMatch || !titleMatch[1].trim()) continue;

    // "field-label" is one class among a tenant's own theme classes, and
    // "Location" is the visible text of the label span right before the
    // value span -- this pattern is what actually survives per-tenant
    // theming, per career-ops-hq's own notes on what broke simpler regexes.
    const locationMatch = card.match(
      /<span\b[^>]*class=["'][^"']*\bfield-label\b[^"']*["'][^>]*>\s*Location\s*<\/span>\s*<span\b[^>]*>\s*([\s\S]*?)<\/span>/,
    );
    const descriptionMatch = card.match(/class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const categoryMatch = card.match(
      /<dt\b[^>]*>\s*Category\s*<\/dt>\s*<dd\b[^>]*>\s*(?:<span\b[^>]*>)?\s*([\s\S]*?)\s*(?:<\/span>)?\s*<\/dd>/,
    );

    results.push({
      title: decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()),
      url: `${parsed.origin}${parsed.pathname}`,
      location: locationMatch ? decodeEntities(locationMatch[1].replace(/\s+/g, " ").trim()) : "",
      description: descriptionMatch ? decodeEntities(stripHtml(descriptionMatch[1])) : "",
      category: categoryMatch ? decodeEntities(stripHtml(categoryMatch[1])) : "",
    });
  }
  return results;
}

async function fetchPage(origin: string, page: number, timeoutMs: number): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(searchUrl(origin, page), {
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/** True when `prefix-token` already looks like a self-contained subdomain label, so it shouldn't get a second "careers-" glued on. */
function looksAlreadyPrefixed(token: string): boolean {
  return /careers-|^jobs-/i.test(token);
}

/**
 * Resolve which subdomain form actually works for a token -- see the file
 * header. Tries `token` as-is first (the common case, since most dataset
 * entries already carry their real prefix), then "careers-"+token as a
 * fallback for the bare-slug minority, unless the token already looks
 * prefixed (in which case doubling it would just produce a nonexistent
 * subdomain, as confirmed while building this adapter).
 */
async function fetchBoard(
  token: string,
  wantCount: number,
  timeoutMs = 15000,
): Promise<{ jobs: IcimsCard[]; failed: boolean }> {
  const candidates = looksAlreadyPrefixed(token) ? [token] : [token, `careers-${token}`];

  for (const candidate of candidates) {
    const origin = `https://${candidate}.icims.com`;
    const firstHtml = await fetchPage(origin, 0, timeoutMs);
    if (firstHtml === null) continue; // try the next candidate form, if any

    const jobs: IcimsCard[] = [];
    let prevFirstUrl: string | null = null;
    let html: string | null = firstHtml;
    let pageNum = 0;

    while (html !== null && jobs.length < wantCount && pageNum < ICIMS_MAX_PAGES) {
      const pageJobs = parseSearchPage(html, origin);
      if (pageJobs.length === 0) break; // past the last page
      if (pageJobs[0].url === prevFirstUrl) break; // some tenants re-serve the last page instead of an empty one
      prevFirstUrl = pageJobs[0].url;
      jobs.push(...pageJobs);

      pageNum += 1;
      if (jobs.length >= wantCount || pageNum >= ICIMS_MAX_PAGES) break;
      await sleep(INTER_PAGE_DELAY_MS);
      html = await fetchPage(origin, pageNum, timeoutMs);
    }
    return { jobs, failed: false };
  }

  return { jobs: [], failed: true }; // neither candidate form resolved
}

/**
 * Pull up to `limit` postings from each board (iCIMS subdomain token) in
 * `boards`, filter by `query` words appearing in the title, then apply
 * include/exclude title logic. Same contract as the other adapters.
 */
export async function searchIcims(
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

  const rawByBoard = new Map<string, { jobs: IcimsCard[]; failed: boolean }>();
  await Promise.all(
    boards.map(async (board) => {
      rawByBoard.set(board, await fetchBoard(board, limit));
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
      const titleLower = job.title.toLowerCase();

      if (queryWords.length > 0 && !queryWords.some((w) => titleMatchesQueryWord(w, titleLower))) {
        continue;
      }

      const titleNormalized = normalizeTitle(job.title);
      if (includeNormalized !== null && !includeNormalized.some((ok) => titleNormalized.includes(ok))) {
        continue;
      }
      if (excludeNormalized.some((bad) => titleNormalized.includes(bad))) {
        continue;
      }

      const idMatch = job.url.match(/\/jobs\/(\d+)\//);
      jobs.push({
        id: `ic_${idMatch ? idMatch[1] : job.url}`,
        title: job.title,
        company: board,
        url: job.url,
        location: job.location,
        salary: "", // not present on the list page; see file header
        category: job.category,
        published: "", // not present on the list page; see file header
        description: job.description.slice(0, 4000),
        source: "icims",
        board,
      });
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
