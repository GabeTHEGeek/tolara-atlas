/**
 * match/candidate.ts
 * The candidate profile's shape and the years arithmetic, kept apart from
 * profile.ts (which calls a model) so the browser can import them: the
 * quiz-based match on the public site builds a profile from answers rather
 * than a resume and scores it with the same score.ts.
 */

import type { Archetype } from "./archetypes.js";

export interface ResumeJob {
  company: string;
  title: string;
  start: string; // "YYYY-MM"
  end: string | null; // null = present
  founder: boolean;
}

export interface CandidateProfile {
  name: string;
  location: { city: string; state: string } | null;
  jobs: ResumeJob[];
  totalYears: number; // union of all product-role date ranges
  employedPmYears: number; // PM roles at companies the candidate didn't found
  founderYears: number;
  archetypes: Array<{ archetype: Archetype; strength: "primary" | "some"; evidence: string }>;
  domains: string[];
  highlights: string[]; // strongest quantified evidence, as written
  skills?: string[]; // tools and skills as listed (SQL, Figma, A/B testing); absent in profiles read before it was added
  mlDepth: "none" | "applied" | "deep";
  managedPeople: boolean;
}

function monthIndex(ym: string): number | null {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

/** Total months covered by a set of [start, end) month ranges, overlaps counted once. */
function unionMonths(ranges: Array<[number, number]>): number {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function yearsFrom(jobs: ResumeJob[], now = Date.now()): { total: number; employed: number; founder: number } {
  const d = new Date(now);
  const nowIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const range = (j: ResumeJob): [number, number] | null => {
    const s = monthIndex(j.start);
    const e = j.end ? monthIndex(j.end) : nowIndex;
    return s == null || e == null ? null : [s, e];
  };
  const all = jobs.map(range).filter((r): r is [number, number] => r != null);
  const employed = jobs.filter((j) => !j.founder).map(range).filter((r): r is [number, number] => r != null);
  const founder = jobs.filter((j) => j.founder).map(range).filter((r): r is [number, number] => r != null);
  const toYears = (months: number) => Math.round((months / 12) * 10) / 10;
  return { total: toYears(unionMonths(all)), employed: toYears(unionMonths(employed)), founder: toYears(unionMonths(founder)) };
}

/**
 * Years of PM experience as a hiring team would count them: employed PM
 * time in full, founder / head-of-product time at two-thirds. A founder
 * runs product, but usually without the scale, team and process an employed
 * PM role is levelled on -- counting it in full put a 3.5-year employed PM
 * at Principal. Two-thirds is the owner's calibration (half undercounted).
 */
export function countedYears(profile: Pick<CandidateProfile, "totalYears" | "employedPmYears" | "founderYears">): number {
  const years = profile.employedPmYears + (profile.founderYears * 2) / 3;
  return Math.round(Math.min(profile.totalYears, years) * 10) / 10;
}
