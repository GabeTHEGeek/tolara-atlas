/**
 * match/rubric.ts
 * The scoring rubric as data: categories, maximum points, and the anchor
 * values each category can award. score.ts reads this rather than having
 * numbers scattered through code, so tuning the rubric is an edit here.
 *
 * This is the owner's Profile v2 rubric: six categories totalling 95,
 * scaled to 100. Domain match is decided by PM archetype
 * (archetypes.ts) rather than a free-form judgement, and Maester's
 * guardrail -- an engineering role wearing a PM title caps the score -- is
 * applied on top.
 */

export type CategoryId = "domain" | "company" | "level" | "requirements" | "location" | "comp";

export interface Category {
  id: CategoryId;
  label: string;
  max: number;
}

export const CATEGORIES: Category[] = [
  { id: "domain", label: "Domain match", max: 25 },
  { id: "company", label: "Company type", max: 20 },
  { id: "level", label: "Level fit", max: 15 },
  { id: "requirements", label: "Requirements", max: 15 },
  { id: "location", label: "Location", max: 10 },
  { id: "comp", label: "Comp", max: 10 },
];

export const RAW_MAX = CATEGORIES.reduce((sum, c) => sum + c.max, 0); // 95

export const ANCHORS = {
  domain: { same: 25, adjacent: 15, newPreferred: 5, newRequired: 0 },
  company: { established: 20, growth: 10, seed: 3, aiFirstStartupAiTitle: 0, unknown: 10 },
  level: { strong: 15, partial: 8, poor: 3 },
  requirements: { met: 15, oneStretch: 8, unmet: 0 },
  location: { preferred: 10, secondary: 5, other: 2 },
  // "Not posted" at a small company isn't in v2; it sits between the large-
  // company 6 and the under-floor 2, since an unposted band is unknown, not
  // low.
  comp: { atTarget: 10, betweenFloorAndTarget: 6, unpostedLarge: 6, unpostedSmall: 4, belowFloor: 2 },
} as const;

/** A role that's really engineering (or needs deep ML) can't score above this, whatever else fits. */
export const ENGINEERING_CAP = 50;

// Companies at or above this many employees count as "established" when
// headcount is known; the posting's own description decides otherwise.
export const ESTABLISHED_EMPLOYEES = 1000;
// "Top brand" for Level fit: big enough that a PM or Sr PM title there
// carries the scope a Lead title does at a mid-size company.
export const TOP_BRAND_EMPLOYEES = 10000;

export type Tier = "Strong Apply" | "Apply" | "Consider" | "Pass";

export function tierOf(score: number): Tier {
  if (score >= 80) return "Strong Apply";
  if (score >= 70) return "Apply";
  if (score >= 60) return "Consider";
  return "Pass";
}

/** The candidate's preferences -- the three questions, pre-filled from the resume. */
export interface Preferences {
  // City names ("New York", "Baltimore") or "Remote US"; matched against a
  // role's offices and its remote flag.
  preferredLocations: string[];
  secondaryLocations: string[];
  relocationOk: boolean;
  payFloor: number; // below this top-of-band is 2 points
  payTarget: number; // at or above this top-of-band is full points
  skipAiFirstStartups: boolean;
}
