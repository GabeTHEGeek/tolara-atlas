/**
 * landingStats.ts
 * Every number on the landing page (#/welcome), worked out in the browser
 * from the same map-data.json the job board loads. The nightly sync rewrites
 * that file, so the page is never more than a day behind the board and there
 * is nothing to update by hand.
 */

import { ghostReason } from "./ghost.js";
import type { MapData, RoleData, Seniority } from "./types.js";

export type LevelId = "all" | Seniority;
export type MetroId = "all" | "remote" | "bay" | "nyc" | "seattle" | "la" | "boston" | "texas" | "chicago" | "dc";

export const LEVELS: ReadonlyArray<readonly [LevelId, string]> = [
  ["all", "Any level"],
  ["associate", "APM"],
  ["mid", "PM"],
  ["senior", "Senior PM"],
  ["principal", "Staff / Principal"],
  ["director", "Director+"],
];

// Cities by metro. A role counts toward a metro when any of its offices is
// in one of these cities; the job data has no metro field of its own.
const METRO_CITIES: Record<Exclude<MetroId, "all" | "remote">, { label: string; cities: string[] }> = {
  bay: {
    label: "Bay Area",
    cities: [
      "San Francisco, CA", "South San Francisco, CA", "Oakland, CA", "Berkeley, CA", "Emeryville, CA", "San Jose, CA",
      "Palo Alto, CA", "East Palo Alto, CA", "Mountain View, CA", "Menlo Park, CA", "Sunnyvale, CA", "USA Sunnyvale, CA",
      "Santa Clara, CA", "Redwood City, CA", "San Mateo, CA", "Foster City, CA", "Cupertino, CA", "Los Gatos, CA",
      "San Bruno, CA", "Burlingame, CA", "Milpitas, CA", "Fremont, CA", "Pleasanton, CA", "Walnut Creek, CA",
      "San Carlos, CA", "Los Altos, CA", "Bay Area, CA", "San Francisco Bay Area, CA",
    ],
  },
  nyc: {
    label: "New York",
    cities: ["New York, NY", "New York City, NY", "Brooklyn, NY", "Manhattan, NY", "Jersey City, NJ", "Hoboken, NJ"],
  },
  seattle: { label: "Seattle", cities: ["Seattle, WA", "Bellevue, WA", "Redmond, WA", "Kirkland, WA", "Bothell, WA"] },
  la: {
    label: "Los Angeles",
    cities: [
      "Los Angeles, CA", "Santa Monica, CA", "Culver City, CA", "Playa Vista, CA", "Venice, CA", "Pasadena, CA",
      "Irvine, CA", "Costa Mesa, CA", "El Segundo, CA", "Burbank, CA", "Long Beach, CA",
    ],
  },
  boston: { label: "Boston", cities: ["Boston, MA", "Cambridge, MA", "Somerville, MA", "Waltham, MA", "Burlington, MA"] },
  texas: {
    label: "Austin / Dallas",
    cities: ["Austin, TX", "Dallas, TX", "Plano, TX", "Irving, TX", "Frisco, TX", "Richardson, TX"],
  },
  chicago: { label: "Chicago", cities: ["Chicago, IL"] },
  dc: {
    label: "Washington DC",
    cities: ["Washington, DC", "Arlington, VA", "McLean, VA", "Herndon, VA", "Reston, VA", "Bethesda, MD"],
  },
};

export const METROS: ReadonlyArray<readonly [MetroId, string]> = [
  ["all", "Anywhere"],
  ["remote", "Remote"],
  ...(Object.entries(METRO_CITIES) as Array<[MetroId, { label: string }]>).map(([id, m]) => [id, m.label] as const),
];

const CITY_TO_METRO = new Map<string, MetroId>();
for (const [id, m] of Object.entries(METRO_CITIES)) for (const c of m.cities) CITY_TO_METRO.set(c, id as MetroId);

/** One open role with everything the landing page asks of it. */
export interface LandingRole {
  role: RoleData;
  companyName: string;
  companySlug: string;
  metros: Set<MetroId>;
  isGhost: boolean;
  isFresh: boolean;
  // Top of a yearly USD band, or null when the posting has none.
  payTop: number | null;
}

/** Every open role once, however many offices it's listed at. */
export function landingRoles(data: MapData, now: number): LandingRole[] {
  const since = Date.parse(data.changes.since);
  const byId = new Map<number, LandingRole>();
  const add = (role: RoleData, companyName: string, companySlug: string, metro: MetroId | null) => {
    let entry = byId.get(role.id);
    if (!entry) {
      const yearlyUsd = (role.salaryPeriod ?? "year") === "year" && (role.salaryCurrency ?? "USD") === "USD";
      const top = role.salaryMax ?? role.salaryMin;
      entry = {
        role,
        companyName,
        companySlug,
        metros: new Set(),
        isGhost: ghostReason(role, now) != null,
        isFresh: Date.parse(role.firstSeenAt) >= since,
        payTop: yearlyUsd && top != null && top >= 30_000 && top <= 2_000_000 ? top : null,
      };
      byId.set(role.id, entry);
    }
    if (metro) entry.metros.add(metro);
    if (role.isRemote) entry.metros.add("remote");
  };
  for (const pin of data.pins) {
    const metro = CITY_TO_METRO.get(`${pin.city}, ${pin.state}`) ?? null;
    for (const role of pin.roles) add(role, pin.companyName, pin.companySlug, role.isRemote ? null : metro);
  }
  for (const company of data.remoteCompanies) {
    for (const role of company.roles) add(role, company.companyName, company.companySlug, "remote");
  }
  return [...byId.values()];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface Slice {
  open: number;
  live: number;
  fresh: number;
  ghost: number;
  medianPayTop: number | null;
  newest: LandingRole[];
}

/** The numbers for one level-and-place pick in the hero card. */
export function slice(roles: LandingRole[], level: LevelId, metro: MetroId): Slice {
  const picked = roles.filter(
    (r) => (level === "all" || r.role.seniority === level) && (metro === "all" || r.metros.has(metro)),
  );
  const ghost = picked.filter((r) => r.isGhost).length;
  const newest = picked
    .filter((r) => !r.isGhost)
    .sort((a, b) => Date.parse(b.role.firstSeenAt) - Date.parse(a.role.firstSeenAt))
    .slice(0, 2);
  return {
    open: picked.length,
    live: picked.length - ghost,
    fresh: picked.filter((r) => r.isFresh).length,
    ghost,
    medianPayTop: median(picked.flatMap((r) => (r.payTop != null ? [r.payTop] : []))),
    newest,
  };
}

/** Median top-of-band pay by level, for the pay chart. */
export function payByLevel(roles: LandingRole[]): Array<{ level: Seniority; label: string; pay: number; sample: number }> {
  const out = [];
  for (const [id, label] of LEVELS) {
    if (id === "all") continue;
    const pays = roles.flatMap((r) => (r.role.seniority === id && r.payTop != null ? [r.payTop] : []));
    const pay = median(pays);
    if (pay != null && pays.length >= 10) out.push({ level: id, label, pay, sample: pays.length });
  }
  return out;
}
