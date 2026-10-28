/**
 * sources/oracle.ts
 * Pulls postings from careers sites built on Oracle Recruiting Cloud
 * (American Express's careers.americanexpress.com, JPMorgan Chase's
 * jpmc.fa.oraclecloud.com, among others) through
 * the keyless REST endpoint the candidate site itself calls:
 *
 *   GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *       ?onlyData=true&expand=requisitionList.secondaryLocations
 *       &finder=findReqs;siteNumber={site},keyword={kw},limit=200,offset=N
 *   -> { items: [{ TotalJobsCount, requisitionList: [{ Id, Title, PostedDate,
 *        PrimaryLocation, secondaryLocations[{ Name }], WorkplaceType }] }] }
 *
 * `token` is "{host}|{siteNumber}|{keyword}" -- e.g.
 * "egug.fa.us2.oraclecloud.com|CX_1|product". The keyword is optional but
 * worth giving: tenants like Amex post thousands of roles worldwide, and
 * "product" narrows that to the few hundred sync.ts's PM filter needs to
 * see, in one or two requests. The list has no description or pay.
 */

import type { RawJob, SearchMeta, SearchOptions } from "./types.js";

const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const PAGE_SIZE = 200;
const MAX_PAGES = 15;
const INTER_PAGE_DELAY_MS = 500;

interface OracleRequisition {
  Id?: string;
  Title?: string;
  PostedDate?: string; // "2026-10-23"
  PrimaryLocation?: string; // "Phoenix, AZ, United States"
  secondaryLocations?: Array<{ Name?: string }>;
  WorkplaceType?: string; // "Hybrid", "Remote", "On-site"
}

interface ParsedToken {
  host: string;
  site: string;
  keyword: string;
}

function parseToken(token: string): ParsedToken | null {
  const [host, site, keyword = ""] = token.split("|").map((p) => p.trim());
  return host && site ? { host, site, keyword } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  t: ParsedToken,
  offset: number,
  timeoutMs = 30000,
): Promise<{ total: number; reqs: OracleRequisition[] } | null> {
  // The finder's own parameters are comma-separated inside one query value,
  // so only the keyword is encoded -- encoding the commas breaks the finder.
  const finder = [
    `siteNumber=${t.site}`,
    t.keyword ? `keyword=${encodeURIComponent(t.keyword)}` : "",
    `limit=${PAGE_SIZE}`,
    `offset=${offset}`,
    // With a keyword, best matches first: the search is loose (JPMorgan's
    // "product manager" matches 5,500 postings, and the endpoint stops near
    // 3,000), but the PM titles all rank in the first few hundred, so the
    // sync's per-board cap keeps every one. Newest first would keep only
    // the newest few hundred matches of any kind.
    `sortBy=${t.keyword ? "RELEVANCY" : "POSTING_DATES_DESC"}`,
  ]
    .filter(Boolean)
    .join(",");
  const url =
    `https://${t.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;${finder}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = (await resp.json()) as { items?: Array<{ TotalJobsCount?: number; requisitionList?: OracleRequisition[] }> };
      const item = body.items?.[0];
      if (!item || !Array.isArray(item.requisitionList)) return null;
      return { total: item.TotalJobsCount ?? 0, reqs: item.requisitionList };
    } catch {
      clearTimeout(timer);
      if (attempt === 0) {
        await sleep(INTER_PAGE_DELAY_MS * 2);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Every requisition the search returns, or `failed: true` if any page couldn't be read (see apple.ts for why all-or-nothing). */
async function fetchBoard(t: ParsedToken, limit: number): Promise<{ reqs: OracleRequisition[]; failed: boolean }> {
  const byId = new Map<string, OracleRequisition>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS);
    const result = await fetchPage(t, page * PAGE_SIZE);
    if (!result) return { reqs: [], failed: true };
    for (const r of result.reqs) if (r.Id) byId.set(r.Id, r);
    if (result.reqs.length < PAGE_SIZE || byId.size >= result.total || byId.size >= limit) break;
  }
  return { reqs: [...byId.values()], failed: false };
}

/** "Phoenix, AZ, United States" -> "Phoenix, AZ" for US offices; other countries kept whole. */
function cleanPlace(name: string): string {
  return name.replace(/,\s*United States$/, "").trim();
}

function locationOf(r: OracleRequisition): string {
  const places = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l) => l.Name)]
    .filter((p): p is string => Boolean(p))
    .map(cleanPlace);
  if (r.WorkplaceType?.toLowerCase() === "remote") places.push("Remote");
  return [...new Set(places)].join("; ");
}

function normalizeJob(token: string, t: ParsedToken, r: OracleRequisition): RawJob {
  const id = r.Id ?? "";
  return {
    id: `or_${t.host.split(".")[0]}_${id}`,
    title: r.Title ?? "",
    company: token,
    // The tenant's own candidate site, which every Oracle host serves.
    url: `https://${t.host}/hcmUI/CandidateExperience/en/sites/${t.site}/job/${id}`,
    location: locationOf(r),
    salary: "", // not in the list response
    category: "",
    published: r.PostedDate ? new Date(`${r.PostedDate}T00:00:00Z`).toISOString() : "",
    description: "", // not in the list response
    source: "oracle",
    board: token,
  };
}

export async function searchOracle(
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
    const t = parseToken(board);
    if (!t) {
      boardsFailed.push(board);
      continue;
    }
    const result = await fetchBoard(t, limit);
    if (result.failed) {
      boardsFailed.push(board);
      continue;
    }
    boardsChecked.push(board);
    if (result.reqs.length === 0) {
      boardsEmpty.push(board);
      continue;
    }
    let kept = 0;
    for (const r of result.reqs) {
      const titleLower = (r.Title ?? "").toLowerCase();
      if (queryWords.length > 0 && !queryWords.some((w) => titleLower.includes(w))) continue;
      jobs.push(normalizeJob(board, t, r));
      kept += 1;
      if (kept >= limit) break;
    }
  }

  return { jobs, meta: { boardsChecked, boardsFailed, boardsEmpty } };
}
