/**
 * Loads Tolara Scout's public data: the same JSON files the website reads,
 * refreshed by the nightly sync. Nothing here needs a key or a server of
 * our own.
 *
 *   TOLARA_DATA_DIR  read from a local folder instead (e.g. ../public/data
 *                    in a checkout, for testing an export before it ships)
 *   TOLARA_SITE_URL  the site to read from; defaults to the live site
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MapData, Seniority } from "../../src/types.js";

export const SITE_URL = (process.env.TOLARA_SITE_URL ?? "https://gabethegeek.github.io/tolara-atlas").replace(/\/$/, "");
const DATA_DIR = process.env.TOLARA_DATA_DIR ?? null;

// The data changes once a day; an hour keeps a long chat session fresh
// without re-downloading 3 MB on every question.
const TTL_MS = 60 * 60 * 1000;

/** One company's file: public/data/companies/<slug>.json. */
export interface CompanyFile {
  generatedAt: string;
  company: { name: string; slug: string };
  signals: Array<{ text: string; tone: string; detail: string }>;
  pulse: { weeks: Array<{ start: string; opened: number; closed: number; open: number }> } | null;
  intelligence: {
    profile: {
      description: string | null;
      founded: number | null;
      headquarters: string | null;
      industries: string[];
      employees: number | null;
      website: string | null;
      linkedinCompanyUrl: string | null;
    } | null;
    leaders: Array<{ name: string; title: string; linkedinUrl: string | null }>;
    news: Array<{ title: string; source: string | null; url: string; publishedAt: string | null }>;
    fetchedAt: string | null;
  } | null;
  roles: Array<{
    id: number;
    title: string;
    team: string | null;
    location: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    salaryPeriod: "year" | "hour" | "month" | null;
    url: string | null;
    postedAt: string | null;
    firstSeenAt: string;
    repostedFrom: string | null;
    isNew: boolean;
    seniority: Seniority;
    offices: Array<{ city: string; state: string; isRemote: boolean }>;
    focus: { bullets: string[] } | null;
  }>;
}

async function load<T>(file: string): Promise<T | null> {
  if (DATA_DIR) {
    try {
      return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8")) as T;
    } catch {
      return null;
    }
  }
  const res = await fetch(`${SITE_URL}/data/${file}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tolara Scout data didn't load (HTTP ${res.status} for ${file})`);
  return (await res.json()) as T;
}

let mapCache: { at: number; data: MapData } | null = null;
let mapPending: Promise<MapData> | null = null;

export async function getMapData(): Promise<MapData> {
  if (mapCache && Date.now() - mapCache.at < TTL_MS) return mapCache.data;
  mapPending ??= load<MapData>("map-data.json")
    .then((data) => {
      if (!data) throw new Error("Tolara Scout's job data is missing (map-data.json)");
      mapCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      mapPending = null;
    });
  return mapPending;
}

const companyCache = new Map<string, { at: number; data: CompanyFile | null }>();

export async function getCompanyFile(slug: string): Promise<CompanyFile | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const hit = companyCache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await load<CompanyFile>(`companies/${slug}.json`);
  companyCache.set(slug, { at: Date.now(), data });
  return data;
}
