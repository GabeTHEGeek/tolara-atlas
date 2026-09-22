/**
 * export/roleFacets.ts
 * Facts about a role that both exports derive the same way: how senior it
 * is, and whether it counts as new. Lives here rather than in either
 * export because map-data.json and the per-company detail files must agree
 * -- a role badged NEW in the map's filter bar and not on its own role page
 * (or vice versa) reads as a bug even when both rules are individually
 * defensible.
 */

export const NEW_ROLE_DAYS = 7;

/**
 * Seniority tiers, ordered lowest to highest. The map's filter chips render
 * in this order, so it's the array that's authoritative, not the union type.
 */
export const SENIORITY_TIERS = ["associate", "mid", "senior", "principal", "director"] as const;
export type Seniority = (typeof SENIORITY_TIERS)[number];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  associate: "Associate",
  mid: "Mid",
  senior: "Senior",
  principal: "Principal / GPM",
  director: "Director+",
};

// Matched high tier first: "Senior Director of Product" is a director role,
// not a senior one, and "Associate Director" is a director role too -- so
// the associate test has to come last, not first. Each pattern is matched
// against the lowercased title with word boundaries, so "Leadership" in a
// team name doesn't make a role a "Lead".
const SENIORITY_PATTERNS: Array<[Seniority, RegExp]> = [
  ["director", /\b(director|vp|vice president|head of|chief|cpo|svp|evp)\b/],
  ["principal", /\b(principal|distinguished|group product manager|gpm|group pm)\b/],
  ["senior", /\b(senior|sr\.?|staff|lead)\b/],
  ["associate", /\b(associate|assoc\.?|junior|jr\.?|apm|intern|entry.level)\b/],
];

/**
 * Best-guess seniority from the posting's own title -- the only signal the
 * ATS gives us for free. "mid" is the unlabeled default, which is a real
 * tier (a plain "Product Manager" is a mid-level posting) but also absorbs
 * anything worded unusually; it's the residual bucket, not a claim.
 */
export function seniorityOf(title: string): Seniority {
  const t = title.toLowerCase();
  for (const [tier, pattern] of SENIORITY_PATTERNS) {
    if (pattern.test(t)) return tier;
  }
  return "mid";
}

/** SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC. */
export function sqliteToIso(ts: string): string {
  return new Date(`${ts.replace(" ", "T")}Z`).toISOString();
}

export function daysSince(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

/**
 * A role is "new" if its own posting date is within the last week. Without
 * a posting date, our first-seen date stands in -- but only for companies
 * we'd already been tracking for over a week, or every role at a company
 * added yesterday would be flagged new.
 */
export function isNewRole(
  role: { posted_at: string | null; first_seen_at: string },
  companyTrackedSince: string,
  now: number,
): boolean {
  if (role.posted_at && !Number.isNaN(Date.parse(role.posted_at))) {
    return daysSince(role.posted_at, now) <= NEW_ROLE_DAYS;
  }
  const firstSeen = sqliteToIso(role.first_seen_at);
  return daysSince(companyTrackedSince, now) > NEW_ROLE_DAYS && daysSince(firstSeen, now) <= NEW_ROLE_DAYS;
}
