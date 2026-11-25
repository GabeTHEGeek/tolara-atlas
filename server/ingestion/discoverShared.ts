/**
 * ingestion/discoverShared.ts
 * What the portfolio-board discovery scripts (discoverA16z.ts,
 * discoverGetro.ts) have in common: turning a posting's apply URL into one
 * of our supported ATS boards, a cheap check that a board belongs to the
 * named company, and verifying new boards with the same live adapters
 * sync.ts uses.
 */

import { searchGreenhouse } from "./sources/greenhouse.js";
import { searchAshby } from "./sources/ashby.js";
import { searchLever } from "./sources/lever.js";
import { searchBambooHr } from "./sources/bamboohr.js";
import { searchWorkday } from "./sources/workday.js";
import { searchPaylocity } from "./sources/paylocity.js";
import { searchIcims } from "./sources/icims.js";
import type { RawJob, SearchMeta } from "./sources/types.js";

export const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1)";

export type Platform = "greenhouse" | "ashby" | "lever" | "bamboohr" | "workday" | "paylocity" | "icims";

export interface Board {
  platform: Platform;
  token: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
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

/**
 * Map an apply URL to one of our supported platforms and the board token
 * that platform's adapter expects. null for anything else (Rippling,
 * company-hosted career sites, etc.) -- those are reported, not guessed at.
 */
export function boardFromApplyUrl(applyUrl: string): Board | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const forParam = url.searchParams.get("for");
    if (forParam) return { platform: "greenhouse", token: forParam.toLowerCase() };
    if (segments[0] && segments[0] !== "embed") return { platform: "greenhouse", token: segments[0].toLowerCase() };
    return null;
  }
  if (host === "jobs.ashbyhq.com" && segments[0]) {
    return { platform: "ashby", token: decodeURIComponent(segments[0]) };
  }
  // jobs.eu.lever.co boards live on a separate API host lever.ts doesn't query.
  if (host === "jobs.lever.co" && segments[0]) {
    return { platform: "lever", token: segments[0].toLowerCase() };
  }
  const bamboo = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (bamboo && bamboo[1] !== "www") {
    return { platform: "bamboohr", token: bamboo[1] };
  }
  // {tenant}.{wdN}.myworkdayjobs.com/[locale/]{site}/job/... -> "tenant|wdN|site",
  // the token shape workday.ts parses.
  const workday = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (workday) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? "") ? segments.slice(1) : segments;
    if (rest[0]) return { platform: "workday", token: `${workday[1]}|${workday[2]}|${rest[0]}` };
    return null;
  }
  const icims = host.match(/^([a-z0-9-]+)\.icims\.com$/);
  if (icims && icims[1] !== "www") {
    return { platform: "icims", token: icims[1] };
  }
  if (host === "recruiting.paylocity.com") {
    const guid = applyUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (guid) return { platform: "paylocity", token: guid[0].toLowerCase() };
  }
  return null;
}

export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Filler that shows up in board tokens but not company names (or vice
// versa): "boxinc", "tryjeeves", "stuut-ai", "keycard-labs", "careers".
export const TOKEN_FILLER = /^(try|join|get|work(at|with)?)|(inc|hq|ai|labs?|careers?|jobs|app|io|co)$/g;

/**
 * True when a board token plausibly belongs to the named company -- a
 * cheap guard against a16z mislabeling another company's postings, not a
 * real identity check. Matches if the whole normalized name appears in the
 * token (or vice versa), or any 3+ character word of the name appears in
 * the token. Workday tokens compare on tenant and site, not the data center
 * in the middle; Paylocity tokens are GUIDs with nothing to compare, so
 * they always pass.
 */
export function nameResemblesToken(name: string, board: Board): boolean {
  if (board.platform === "paylocity") return true;
  const rawToken =
    board.platform === "workday" ? board.token.split("|").filter((_, i) => i !== 1).join(" ") : board.token;
  const token = normalizeForMatch(rawToken);
  const strippedToken = token.replace(TOKEN_FILLER, "");
  const fullName = normalizeForMatch(name);
  if (!token || !fullName) return false;
  if (token.includes(fullName) || fullName.includes(token)) return true;
  if (strippedToken.length >= 3 && fullName.includes(strippedToken)) return true;
  return name
    .split(/[^A-Za-z0-9]+/)
    .map(normalizeForMatch)
    .some((word) => word.length >= 3 && token.includes(word));
}

export function mostCommon<T>(items: T[], keyOf: (item: T) => string): T | null {
  const counts = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { item, count: 1 });
  }
  let best: { item: T; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.item ?? null;
}

export async function fetchPlatform(platform: Platform, boards: string[]): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  // No per-board limit here (unlike discoverCompanies.ts's limit: 1): the
  // adapters cap BEFORE the PM filter runs, so limit: 1 would only ever
  // test a board's first posting.
  const options = { boards, limit: 500 };
  switch (platform) {
    case "greenhouse":
      return searchGreenhouse("", options);
    case "ashby":
      return searchAshby("", options);
    case "lever":
      return searchLever("", options);
    case "bamboohr":
      return searchBambooHr("", options);
    case "workday":
      return searchWorkday("", options);
    case "paylocity":
      return searchPaylocity("", options);
    case "icims":
      return searchIcims("", options);
  }
}

