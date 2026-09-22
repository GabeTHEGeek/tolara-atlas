/**
 * filters.ts
 * The map's role filters. Applied to the exported pin list in App.tsx
 * before anything renders, so the map, the company search, the open
 * company panel and the unmapped list all agree on which roles exist --
 * a pin whose roles are all filtered out disappears rather than opening
 * to an empty panel.
 *
 * Every field here is one the export already carries (see
 * server/export/roleFacets.ts); nothing is inferred in the browser.
 */

import type { LocationPinData, RemoteCompanyData, RoleData, Seniority } from "./types.js";

export type RemoteMode = "all" | "office-only" | "remote-only";

export interface RoleFilters {
  // Empty set means "any" rather than "none" -- an empty filter shows
  // everything, which is also what an all-chips-off state should do.
  seniority: Set<Seniority>;
  // Dollars. A role has to publish a band to clear this bar at all: we
  // can't claim an unbanded posting pays above a floor, so filtering by
  // salary necessarily also filters to roles that state one. The UI says
  // so next to the control.
  minSalary: number | null;
  // Days. Falls back to firstSeenAt when the board's own postedAt is
  // missing or unparseable ("Posted Yesterday" and friends).
  postedWithinDays: number | null;
  newOnly: boolean;
  remote: RemoteMode;
}

export const EMPTY_FILTERS: RoleFilters = {
  seniority: new Set(),
  minSalary: null,
  postedWithinDays: null,
  newOnly: false,
  remote: "all",
};

export function isFiltering(f: RoleFilters): boolean {
  return (
    f.seniority.size > 0 || f.minSalary != null || f.postedWithinDays != null || f.newOnly || f.remote !== "all"
  );
}

/**
 * The most recent date we can defend for a role: its own posting date when
 * the board gave us a real one, otherwise when our sync first saw it.
 * Returns null only if neither parses, in which case date filters skip it
 * rather than guessing.
 */
function roleDate(role: RoleData): number | null {
  if (role.postedAt) {
    const posted = Date.parse(role.postedAt);
    if (!Number.isNaN(posted)) return posted;
  }
  const seen = Date.parse(role.firstSeenAt);
  return Number.isNaN(seen) ? null : seen;
}

export function roleMatches(role: RoleData, f: RoleFilters, now: number): boolean {
  if (f.seniority.size > 0 && !f.seniority.has(role.seniority)) return false;

  if (f.minSalary != null) {
    // An hourly or monthly band can't be compared to a yearly floor without
    // inventing an assumption about hours worked, so those roles sit out a
    // salary filter rather than being converted or silently passed.
    if ((role.salaryPeriod ?? "year") !== "year") return false;
    // Compare against the top of the band: a $150-200k role clears a $180k
    // floor, since that's a salary the role can actually pay.
    const ceiling = role.salaryMax ?? role.salaryMin;
    if (ceiling == null || ceiling < f.minSalary) return false;
  }

  if (f.newOnly && !role.isNew) return false;

  if (f.postedWithinDays != null) {
    const date = roleDate(role);
    if (date == null || now - date > f.postedWithinDays * 86_400_000) return false;
  }

  if (f.remote === "office-only" && role.isRemote) return false;
  if (f.remote === "remote-only" && !role.isRemote) return false;

  return true;
}

/**
 * Pins with their role lists narrowed, dropping any pin left with nothing.
 * roleCount is recomputed rather than kept, since it drives the pin's size
 * on the map and its "N open roles" heading.
 */
export function filterPins(pins: LocationPinData[], f: RoleFilters, now: number): LocationPinData[] {
  if (!isFiltering(f)) return pins;
  const out: LocationPinData[] = [];
  for (const pin of pins) {
    const roles = pin.roles.filter((r) => roleMatches(r, f, now));
    if (roles.length > 0) out.push({ ...pin, roles, roleCount: roles.length });
  }
  return out;
}

export function filterRemoteCompanies(
  companies: RemoteCompanyData[],
  f: RoleFilters,
  now: number,
): RemoteCompanyData[] {
  if (!isFiltering(f)) return companies;
  const out: RemoteCompanyData[] = [];
  for (const company of companies) {
    const roles = company.roles.filter((r) => roleMatches(r, f, now));
    if (roles.length > 0) out.push({ ...company, roles, roleCount: roles.length });
  }
  return out;
}

/** Distinct roles across pins and the unmapped list -- a role open in three offices counts once. */
export function countRoles(pins: LocationPinData[], remoteCompanies: RemoteCompanyData[]): number {
  const ids = new Set<number>();
  for (const pin of pins) for (const role of pin.roles) ids.add(role.id);
  for (const company of remoteCompanies) for (const role of company.roles) ids.add(role.id);
  return ids.size;
}
