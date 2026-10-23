/**
 * sources/atlassian.ts
 * Pulls Atlassian's postings from the JSON feed behind
 * atlassian.com/company/careers.
 *
 * Atlassian's roles live on iCIMS, but not on a tenant icims.ts can read:
 * postings are spread across several regional portals
 * (globalcareers-atlassian, careers-americas, ...) whose search pages come
 * back empty to that adapter. The careers page itself is fed by one public
 * endpoint, /endpoint/careers/listings, that returns EVERY posting
 * worldwide in a single unauthenticated response (~360 today, ~2.5MB) with
 * title, locations, category, the description sections and the pay-range
 * HTML -- so this is one request per sync, no paging, no scraping.
 *
 * Only the one board token "atlassian" is valid.
 */

import { stripHtml } from "./common.js";
import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const ATLASSIAN_BOARD = "atlassian";
const LISTINGS_URL = "https://www.atlassian.com/endpoint/careers/listings";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";

interface AtlassianListing {
  id: string | number;
  title?: string;
  locations?: string[];
  category?: string;
  overview?: string | null;
  responsibilities?: string | null;
  qualifications?: string | null;
  payRanges?: string | null;
  applyUrl?: string;
  portalJobPost?: { portalUrl?: string; updatedDate?: string };
}

async function fetchListings(timeoutMs = 30000): Promise<AtlassianListing[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(LISTINGS_URL, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = (await resp.json()) as unknown;
      return Array.isArray(data) ? (data as AtlassianListing[]) : null;
    } catch {
      clearTimeout(timer);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/**
 * Each entry is "<office> - <country> - <address>", e.g.
 * "San Francisco - United States -   San Francisco, California 94104 United States"
 * -> "San Francisco, California, United States". Office and country are
 * clean; the address is only mined for the US state, since its postcode
 * and spacing vary by country. Remote entries ("Remote - Remote",
 * "Remote - India - Remote", "Remote-EMEA - Remote") become "Remote" or
 * "Remote, India".
 */
function cleanLocation(raw: string): string {
  const parts = raw.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  const [office = "", second = ""] = parts;
  if (/^remote/i.test(office)) {
    return parts.length > 2 && !/^remote$/i.test(second) ? `Remote, ${second}` : "Remote";
  }
  if (parts.length < 3) return /^remote$/i.test(second) ? "Remote" : office; // "Manila - Remote", "Canada - Canada"
  const country = second.replace(/\s+or Remote$/i, "");
  if (country !== "United States") return `${office}, ${country}`;
  if (/\bDC\b/.test(office)) return "Washington, DC, United States";
  const state = parts[2].match(/,\s*([A-Za-z ]+?)\s+(?:\d|United States)/)?.[1];
  return [office, state, country].filter(Boolean).join(", ");
}

/** "2026-09-30 05:33 PM" -> ISO; "" if unparseable. Treated as UTC -- the feed gives no zone. */
function isoDate(updated: string | undefined): string {
  const m = updated?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return "";
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, Number(m[5]))).toISOString();
}

function normalizeJob(job: AtlassianListing): RawJob {
  const id = String(job.id);
  const description = stripHtml([job.overview, job.responsibilities, job.qualifications].filter(Boolean).join(" "));
  return {
    id: `at_${id}`,
    title: job.title ?? "",
    company: ATLASSIAN_BOARD,
    url: job.portalJobPost?.portalUrl ?? job.applyUrl?.replace(/\?mode=apply$/, "") ?? "",
    location: [...new Set((job.locations ?? []).map(cleanLocation).filter(Boolean))].join("; "),
    // The US pay-zone text ("Zone A: $228,600 - $298,450 ...") -- salary.ts
    // takes the first band, i.e. the highest-cost zone. Non-USD bands are
    // dropped: they use local separators ("322.200 zł") salary.ts misreads.
    salary: job.payRanges?.includes("$") ? stripHtml(job.payRanges) : "",
    category: job.category ?? "",
    published: isoDate(job.portalJobPost?.updatedDate),
    description: description.slice(0, 4000),
    source: "atlassian",
    board: ATLASSIAN_BOARD,
  };
}

/** Same contract as the other adapters; `boards` should be ["atlassian"]. */
export async function searchAtlassian(
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
    if (board !== ATLASSIAN_BOARD) {
      boardsFailed.push(board);
      continue;
    }
    const listings = await fetchListings();
    if (!listings) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    if (listings.length === 0) {
      boardsEmpty.push(board);
      continue;
    }
    let kept = 0;
    for (const job of listings) {
      const titleLower = (job.title ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(job));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
