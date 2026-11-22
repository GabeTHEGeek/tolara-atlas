/**
 * ghost.ts
 * "Possible ghost job": a posting that has stayed up long enough that it may
 * not be a live opening -- an evergreen résumé collector, a role already
 * filled internally, or one kept up to look like the company is growing.
 *
 * We can't see inside a company, so this is only a timing signal, and the
 * label says "possible". A role qualifies when, counting from its ORIGINAL
 * posting (a repost doesn't reset the clock, see export/reposts.ts):
 *   - it has been open GHOST_DAYS or more, or
 *   - it was taken down and reposted, and has been open REPOST_GHOST_DAYS
 *     or more (a repost that still isn't filled weeks later is the classic
 *     pattern).
 * Most PM roles fill or close within about two months, so 90 days leaves
 * room for slow but genuine searches.
 */

import { openSince } from "./format.js";
import { roleDate } from "./filters.js";
import type { RoleData } from "./types.js";

export const GHOST_DAYS = 90;
export const REPOST_GHOST_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

type GhostInput = Pick<RoleData, "postedAt" | "firstSeenAt" | "repostedFrom">;

/** Why a role looks like a possible ghost job, or null when it doesn't. */
export function ghostReason(role: GhostInput, now: number = Date.now()): string | null {
  const since = openSince(roleDate(role), role.repostedFrom);
  if (since == null) return null;
  const days = Math.floor((now - since) / DAY_MS);
  if (days >= GHOST_DAYS) {
    return `Open ${days} days. Postings up this long are often already filled, on hold, or kept up to collect résumés.`;
  }
  if (role.repostedFrom && days >= REPOST_GHOST_DAYS) {
    return `Taken down and reposted, and still open after ${days} days. It may not be an active search.`;
  }
  return null;
}
