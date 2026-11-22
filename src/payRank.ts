/**
 * payRank.ts
 * Where a role's posted pay sits among every other open role at the same
 * level: "Top 12% for Senior PM roles". Built in the browser from the map
 * data, so it's always computed over exactly the roles on the board.
 *
 * Only yearly USD bands count, on both sides -- an hourly or foreign-
 * currency band can't be ranked against a US salary without inventing a
 * conversion. A band is ranked by its midpoint. Levels with too few banded
 * roles to rank against get no rank at all rather than a noisy one.
 */

import type { LocationPinData, RemoteCompanyData, Seniority } from "./types.js";

const MIN_SAMPLE = 30;

interface Banded {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod?: string | null;
  seniority: Seniority;
}

export interface PayRank {
  // Share of same-level banded roles this one pays more than, 0-100.
  percentile: number;
  seniority: Seniority;
  sampleSize: number;
}

export type PayRanker = (role: Banded) => PayRank | null;

function midpoint(role: Banded): number | null {
  if ((role.salaryPeriod ?? "year") !== "year") return null;
  if ((role.salaryCurrency ?? "USD") !== "USD") return null;
  const { salaryMin: min, salaryMax: max } = role;
  if (min == null && max == null) return null;
  const mid = min != null && max != null ? (min + max) / 2 : (min ?? max)!;
  // Guards against a stray mis-parsed figure ranking as the lowest PM pay in the country.
  return mid >= 30_000 ? mid : null;
}

export function buildPayRanker(pins: LocationPinData[], remoteCompanies: RemoteCompanyData[]): PayRanker {
  const seen = new Set<number>();
  const byLevel = new Map<Seniority, number[]>();
  const add = (role: Banded & { id: number }) => {
    if (seen.has(role.id)) return; // a role open in several offices counts once
    seen.add(role.id);
    const mid = midpoint(role);
    if (mid == null) return;
    const list = byLevel.get(role.seniority) ?? [];
    list.push(mid);
    byLevel.set(role.seniority, list);
  };
  for (const pin of pins) pin.roles.forEach(add);
  for (const company of remoteCompanies) company.roles.forEach(add);
  for (const list of byLevel.values()) list.sort((a, b) => a - b);

  return (role) => {
    const mid = midpoint(role);
    const list = byLevel.get(role.seniority);
    if (mid == null || !list || list.length < MIN_SAMPLE) return null;
    // Count below, plus half of the ties, so a band shared by many roles
    // lands in the middle of them rather than at either end.
    let below = 0;
    let equal = 0;
    for (const v of list) {
      if (v < mid) below += 1;
      else if (v === mid) equal += 1;
      else break;
    }
    const percentile = Math.round(((below + equal / 2) / list.length) * 100);
    return { percentile, seniority: role.seniority, sampleSize: list.length };
  };
}

/** "Top 12%" / "Bottom 30%" / "Middle of the range". */
export function payRankShort(rank: PayRank): string {
  if (rank.percentile >= 60) return `Top ${Math.max(1, 100 - rank.percentile)}%`;
  if (rank.percentile <= 40) return `Bottom ${Math.max(1, rank.percentile)}%`;
  return "Middle of the range";
}
