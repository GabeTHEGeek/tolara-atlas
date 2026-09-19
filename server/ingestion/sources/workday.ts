/**
 * sources/workday.ts
 * Pulls live job listings directly from individual companies' Workday
 * career sites. Workday has no single documented public API either, but
 * every tenant's careers page is backed by a keyless JSON endpoint the page
 * itself calls (the "CXS" -- Candidate Experience Site -- API):
 *
 *   POST https://{tenant}.{datacenter}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   body: { appliedFacets: {}, limit, offset, searchText: "" }
 *   -> { total, jobPostings: [{ title, externalPath, locationsText, postedOn, bulletFields }] }
 *
 * Confirmed live against real tenants (23andMe, FedEx) before writing this
 * adapter, including the one hard constraint that shapes the rest of the
 * file: Workday caps `limit` at 20 per request (a limit above that 400s),
 * so pulling more than 20 postings from one board means paging through
 * with `offset`, unlike the single-shot fetch the other three adapters use.
 *
 * `token` here is a THREE-PART composite -- "{tenant}|{datacenter}|{site}"
 * (e.g. "23andme|wd5|23") -- because Workday's URL needs all three and
 * there's no way to derive one from another. data/discovery/workday_tokens.json
 * stores candidates in exactly this packed form; parseToken splits it back
 * apart. A malformed token (not exactly three non-empty parts) is treated
 * as a failed board without making a network call at all.
 *
 * Because pagination makes each board cost up to ceil(limit/20) requests
 * instead of one, `fetchBoard` here takes the caller's `limit` directly and
 * stops paging once it's satisfied (or the board's own total is reached,
 * or a page comes back empty/failed) -- unlike greenhouse.ts/ashby.ts/
 * lever.ts, which always fetch a board's FULL unfiltered post list and
 * only apply `limit` when normalizing results afterward. That fetch-
 * everything approach doesn't scale here: sync.ts's PER_BOARD_LIMIT (500)
 * would mean up to 25 sequential requests for every large Workday board on
 * every sync, most of it work nothing downstream needs.
 *
 * `locationsText` is frequently a bare placeholder ("3 Locations") instead
 * of naming any office at all, for any posting open in more than one --
 * confirmed on Capital One's board, where every such posting was landing
 * on whatever single city geocode.ts's board-wide fallback happened to
 * resolve from a DIFFERENT, single-location posting (wrong for roles
 * actually based somewhere else). locationFromExternalPath fixes this
 * without an extra per-job request: `externalPath` always leads with the
 * posting's real primary office as a "/job/City-Name-ST/..." slug, so
 * that's used as the location whenever locationsText is just a count.
 */

import { normalizeTitle, titleMatchesQueryWord } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const WORKDAY_PAGE_SIZE = 20; // Workday's own hard cap -- confirmed live; limit > 20 returns HTTP 400.
// Workday's CXS API is fronted by a WAF that rate-limits in bursts -- a
// courtesy delay between pages of the SAME board (not between different
// boards, which already run in parallel via Promise.all below) keeps a
// multi-page fetch from tripping it. Cross-checked against career-ops-hq's
// production Workday scraper, which documents a 429 silently truncating an
// entire tenant's results without this.
const INTER_PAGE_DELAY_MS = 250;

// During Workday's weekly maintenance window, every CXS request on an
// affected data center (confirmed live: all of wd1/wd3/wd5 at once, while
// wd10/wd12/wd5xx kept serving) 303-redirects here instead of returning
// JSON. fetch follows the redirect, so it shows up as the response's final
// URL.
const MAINTENANCE_URL_MARKER = "community.workday.com/maintenance";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for Workday's placeholder text used instead of naming a location when a posting spans multiple offices ("2 Locations", "10 Locations"). */
function isLocationCountPlaceholder(text: string): boolean {
  return /^\d+\s+Locations?$/i.test(text.trim());
}

/**
 * "/job/Richmond-VA/Manager--Product-Management..." -> "Richmond, VA"
 * "/job/New-York-NY/Senior-Associate..." -> "New York, NY"
 * "/job/Toronto-ON/..." -> "Toronto, ON" (non-US; left for the shared
 * locationParser's own city/state and non-US-name matching to sort out
 * downstream, same as any other raw location string this project stores)
 * "/job/Boston/Head-of-Product..." -> "Boston" (some tenants -- confirmed
 * on Roche's board -- omit the state suffix entirely for a single-office
 * segment; passed through bare rather than dropped, since the shared
 * parser's own known-US-city table resolves plenty of these unambiguously
 * (Boston -> MA) while still safely leaving a genuinely ambiguous or
 * non-US bare name unresolved rather than guessing)
 *
 * Workday's externalPath always leads with the posting's PRIMARY office as
 * a hyphen-joined "City-Name-ST"-shaped segment -- confirmed live against
 * Capital One's board, including multi-word cities ("New-York-NY") and
 * non-US segments ("Bangalore-In", "Mexico-City-Mexico"). That's a real,
 * specific place even when locationsText is just a bare "3 Locations"
 * count with no city named at all, so it's used as the fallback whenever
 * locationsText doesn't already name one. Without this, every multi-office
 * posting on a board collapsed onto whatever single office geocode.ts's
 * board-wide fallback happened to resolve from someone else's
 * single-location posting -- confirmed wrong on Capital One's board, where
 * NYC/Richmond/McLean roles were all landing on its one Plano, TX posting.
 */
function locationFromExternalPath(externalPath: string): string {
  const segment = externalPath.match(/^\/job\/([^/]+)\//)?.[1];
  if (!segment) return "";
  const parts = segment.split("-").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]; // no state suffix in the slug -- pass the bare name through, see header
  const state = parts[parts.length - 1];
  const city = parts.slice(0, -1).join(" ");
  return city ? `${city}, ${state}` : "";
}

interface WorkdayJobPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface ParsedWorkdayToken {
  tenant: string;
  dataCenter: string;
  site: string;
}

function parseToken(token: string): ParsedWorkdayToken | null {
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [tenant, dataCenter, site] = parts.map((p) => p.trim());
  if (!tenant || !dataCenter || !site) return null;
  return { tenant, dataCenter, site };
}

/**
 * Fetch up to `wantCount` postings from one company's Workday board, paging
 * in batches of WORKDAY_PAGE_SIZE. Never throws -- `failed: true` covers a
 * malformed token, a network error, a timeout (even after one retry), or a
 * non-2xx response on the FIRST page (an invalid tenant/site 422s
 * immediately, confirmed live). A failure on a LATER page just stops
 * pagination early and returns whatever was already fetched -- a board
 * that's real and mostly working shouldn't lose its first 40 good results
 * because request #3 timed out. `failed: false` with an empty array is a
 * board that loaded fine with zero current postings. `maintenance: true`
 * marks a failure caused by Workday's scheduled maintenance redirect (see
 * MAINTENANCE_URL_MARKER) -- still a failure, just a known, temporary one.
 */
async function fetchBoard(
  token: string,
  wantCount: number,
  timeoutMs = 15000,
): Promise<{ jobs: WorkdayJobPosting[]; failed: boolean; maintenance?: boolean }> {
  const parsed = parseToken(token);
  if (!parsed) return { jobs: [], failed: true };
  const { tenant, dataCenter, site } = parsed;
  const url = `https://${tenant}.${dataCenter}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;

  const jobs: WorkdayJobPosting[] = [];
  let offset = 0;
  let total: number | null = null;
  let firstPage = true;
  let inMaintenance = false;

  while (jobs.length < wantCount && (total === null || offset < total)) {
    if (!firstPage) await sleep(INTER_PAGE_DELAY_MS);
    const pageLimit = Math.min(WORKDAY_PAGE_SIZE, wantCount - jobs.length);
    let page: { total: number; jobPostings: WorkdayJobPosting[] } | null = null;

    // 3 attempts total, not 2 like the other adapters' plain retry-once --
    // a 429 here is a documented, common failure mode (Workday's WAF rate-
    // limiting in bursts), not a rare network blip, so it gets one extra
    // chance to back off and succeed rather than silently truncating a
    // board's results at whatever page it happened to hit the limit on.
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: pageLimit, offset, searchText: "" }),
        });
        clearTimeout(timer);
        // No point retrying -- the window lasts hours, not seconds.
        if (resp.url.includes(MAINTENANCE_URL_MARKER)) {
          inMaintenance = true;
          break;
        }
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          break; // treated as a failed page below
        }
        if (!resp.ok) break; // non-retryable 4xx -- treated as a failed page below
        page = (await resp.json()) as { total: number; jobPostings: WorkdayJobPosting[] };
        break;
      } catch {
        clearTimeout(timer);
        if (attempt < 2) continue;
        break; // treated as a failed page below
      }
    }

    if (!page) {
      // First page failing means the board itself couldn't be read at all;
      // a later page failing just means stop paging with what we have.
      if (firstPage) return { jobs: [], failed: true, maintenance: inMaintenance };
      break;
    }

    firstPage = false;
    total = page.total;
    jobs.push(...page.jobPostings);
    if (page.jobPostings.length === 0) break; // defensive -- avoid an infinite loop on an unexpected shape
    offset += page.jobPostings.length;
  }

  return { jobs, failed: false };
}

/**
 * Pull up to `limit` postings from each board in `boards` (three-part
 * Workday tokens), filter by `query` words appearing in the title, then
 * apply include/exclude title logic. Same contract as the other three
 * adapters, except `limit` here also bounds how much is FETCHED, not just
 * how much is kept after filtering -- see the file header for why.
 */
export async function searchWorkday(
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
  const boardsInMaintenance: string[] = [];

  const rawByBoard = new Map<string, { jobs: WorkdayJobPosting[]; failed: boolean; maintenance?: boolean }>();
  await Promise.all(
    boards.map(async (board) => {
      rawByBoard.set(board, await fetchBoard(board, limit));
    }),
  );

  for (const board of boards) {
    const result = rawByBoard.get(board) ?? { jobs: [], failed: true };
    if (result.failed) {
      boardsFailed.push(board);
      if (result.maintenance) boardsInMaintenance.push(board);
      continue;
    }
    boardsChecked.push(board);
    const rawJobs = result.jobs;
    if (rawJobs.length === 0) {
      boardsEmpty.push(board);
      continue;
    }

    const parsed = parseToken(board)!; // board came from `boards`, already validated by fetchBoard succeeding
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

      const externalPath = job.externalPath ?? "";
      const locationsText = job.locationsText ?? "";
      const location =
        locationsText && !isLocationCountPlaceholder(locationsText)
          ? locationsText
          : locationFromExternalPath(externalPath) || locationsText;
      jobs.push({
        id: `wd_${externalPath || `${board}_${boardJobCount}`}`,
        title,
        company: board,
        url: externalPath
          ? `https://${parsed.tenant}.${parsed.dataCenter}.myworkdayjobs.com/${parsed.site}${externalPath}`
          : "",
        location,
        salary: "", // not available from the list endpoint -- see file header
        category: "",
        published: job.postedOn ?? "",
        description: "", // not available from the list endpoint -- see file header
        source: "workday",
        board,
      });
      boardJobCount += 1;
      if (boardJobCount >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty, boardsInMaintenance } };
}

// Legal-entity and regional-subsidiary noise stripped from
// hiringOrganization names, which are often the specific legal entity
// behind a posting rather than the brand: "PUMA North America, Inc." ->
// "PUMA", "LE008 Duck Creek Technologies India LLP" -> "Duck Creek
// Technologies", "DE05 CGM SE & Co. KGaA" -> "CGM".
//
// Leading internal entity codes: an all-caps/digit token containing a digit
// ("LE008", "1000", "PII01") or a country-pair code ("CO_US"). Requires 3+
// characters so a real short name like "3M Company" survives.
const ENTITY_CODE_PREFIX = /^(?:(?=[A-Z0-9_]*\d)[A-Z0-9_]{3,}|[A-Z]{2,}_[A-Z]{2,})\s+/;
const LEGAL_SUFFIX =
  /\s+(inc|llc|l\.l\.c|llp|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|kgaa|se|sa|s\.a|sas|s\.a\.s|bv|b\.v|nv|n\.v|n\.a|lp|l\.p|pty|pte|public|sp\. z o\.o|holdings?|&)\.?$/i;
const REGION_SUFFIX =
  /\s+(north america|americas|usa|us|u\.s\.|united states|international|global|india|asia|canada|poland|europe|emea|uk)$/i;

function cleanLegalName(name: string): string {
  // Everything after the first comma is legal/branch detail ("..., Inc.",
  // "..., Ltd. Shenzhen Branch"); parentheticals are too ("(US)").
  let cleaned = name.split(",")[0].replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(ENTITY_CODE_PREFIX, "").trim();
  // Repeat for stacked tails like "CGM SE & Co. KGaA" or "PUMA North America Inc".
  for (let i = 0; i < 6; i++) {
    const next = cleaned.replace(LEGAL_SUFFIX, "").replace(REGION_SUFFIX, "").trim();
    if (next === cleaned || next === "") break;
    cleaned = next;
  }
  return cleaned;
}

/**
 * The real company name behind a Workday board, for display. Tokens are
 * "{tenant}|{datacenter}|{site}", which say nothing readable about the
 * company ("duckcreek|wd1|duckcreekcareers", "peak6group|wd1|weinsure"),
 * but each posting's detail endpoint reports a hiringOrganization.name.
 * Reads up to 10 postings and takes the most common cleaned name (a tenant
 * can post for several subsidiaries and regional entities). null when the board
 * can't be read -- including during Workday's maintenance window -- or has
 * no postings, so callers can keep whatever name they already have.
 */
export { cleanLegalName };

export async function fetchWorkdayCompanyName(token: string, timeoutMs = 15000): Promise<string | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const { tenant, dataCenter, site } = parsed;
  const base = `https://${tenant}.${dataCenter}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

  const getJson = async (url: string, init?: RequestInit): Promise<unknown | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      if (!resp.ok || resp.url.includes(MAINTENANCE_URL_MARKER)) return null;
      return await resp.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const list = (await getJson(`${base}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 10, offset: 0, searchText: "" }),
  })) as { jobPostings?: WorkdayJobPosting[] } | null;
  const paths = (list?.jobPostings ?? []).map((j) => j.externalPath).filter((p): p is string => Boolean(p));

  const counts = new Map<string, number>();
  for (const externalPath of paths) {
    const detail = (await getJson(`${base}${externalPath}`)) as { hiringOrganization?: { name?: string } } | null;
    const name = cleanLegalName(detail?.hiringOrganization?.name ?? "");
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [name, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = name;
  }
  return best;
}
