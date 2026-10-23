/**
 * sources/smartrecruiters.ts
 * Pulls postings from companies' SmartRecruiters career boards (Canva,
 * among others) through SmartRecruiters' public Posting API:
 *
 *   GET https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100&offset=N
 *   -> { totalFound, content: [{ id, name, releasedDate, location{...}, function{...} }] }
 *
 * Keyless and documented for exactly this use (public job listings). The
 * list has no description -- that's one extra request per posting, which
 * this adapter doesn't make, to stay a request or two per board like the
 * others -- so roles from here have no focus bullets on the role page.
 *
 * `token` is the company identifier as it appears in the API and in
 * jobs.smartrecruiters.com/{token} URLs -- case-sensitive ("Canva").
 */

import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const API_URL = "https://api.smartrecruiters.com/v1/companies/{token}/postings";
const JOB_URL = "https://jobs.smartrecruiters.com/{token}/{id}";
const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_SIZE = 100; // the API's maximum
const MAX_PAGES = 20;
const INTER_PAGE_DELAY_MS = 250;

interface SrPosting {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
  function?: { label?: string };
  department?: { label?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(token: string, offset: number, timeoutMs = 20000): Promise<{ total: number; postings: SrPosting[] } | null> {
  const url = `${API_URL.replace("{token}", encodeURIComponent(token))}?limit=${PAGE_SIZE}&offset=${offset}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = (await resp.json()) as { totalFound?: number; content?: SrPosting[] };
      if (!Array.isArray(body.content)) return null;
      return { total: body.totalFound ?? 0, postings: body.content };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) {
        await sleep(INTER_PAGE_DELAY_MS * 4);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Every posting on the board, or `failed: true` if any page couldn't be read (see apple.ts for why all-or-nothing). */
async function fetchBoard(token: string, limit: number): Promise<{ postings: SrPosting[]; failed: boolean }> {
  const postings: SrPosting[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS);
    const result = await fetchPage(token, page * PAGE_SIZE);
    if (!result) return { postings: [], failed: true };
    postings.push(...result.postings);
    if (result.postings.length < PAGE_SIZE || postings.length >= result.total || postings.length >= limit) break;
  }
  return { postings, failed: false };
}

/** "Austin, TX" for a US office, the API's own full location elsewhere, "Remote" for remote ones. */
function locationOf(p: SrPosting): string {
  const l = p.location ?? {};
  if (l.remote && !l.city) return "Remote";
  if (l.country?.toLowerCase() === "us" && l.city) return l.region ? `${l.city}, ${l.region}` : l.city;
  return l.fullLocation ?? [l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(", ");
}

function normalizeJob(token: string, p: SrPosting): RawJob {
  const id = p.id ?? "";
  return {
    id: `sr_${id}`,
    title: p.name ?? "",
    company: token,
    url: JOB_URL.replace("{token}", encodeURIComponent(token)).replace("{id}", id),
    location: locationOf(p),
    salary: "", // only in each posting's detail
    category: p.function?.label ?? p.department?.label ?? "",
    published: p.releasedDate ?? "",
    description: "", // only in each posting's detail
    source: "smartrecruiters",
    board: token,
  };
}

export async function searchSmartRecruiters(
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
    const result = await fetchBoard(board, limit);
    if (result.failed) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    if (result.postings.length === 0) {
      boardsEmpty.push(board);
      continue;
    }
    let kept = 0;
    for (const p of result.postings) {
      const titleLower = (p.name ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(board, p));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
