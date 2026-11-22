/**
 * export/reposts.ts
 * Which open roles are reposts: the company took a posting down and put the
 * same job back up as a new posting. Shown as a "Reposted" tag, and the
 * role's days-open count starts from the ORIGINAL posting, since a repost
 * resets the board's own date but not how long the job has been unfilled.
 *
 * A role counts as a repost of an earlier one when both are at the same
 * company on the same careers site, with the same title and location
 * text, and the earlier one closed shortly before (or the day) the new one
 * appeared, within the last 180 days.
 *
 * Deliberately strict: big companies run several separate openings under
 * one generic title ("Principal Product Manager", Redmond, WA at Microsoft),
 * and those would all read as reposts of each other. So a match only
 * counts when that title + location is unique on both sides: exactly one
 * open role with it, and exactly one earlier closed role that fits. A
 * missed repost costs nothing; a false "Reposted" tag misleads.
 */

import type Database from "better-sqlite3";
import { sqliteToIso } from "./roleFacets.js";

/** Active role id -> ISO time our sync first saw the posting it replaced. */
export function loadRepostedFrom(db: Database.Database): Map<number, string> {
  const rows = db
    .prepare(
      `WITH k AS (
         SELECT id, company_id, platform, status, first_seen_at, last_seen_at,
                lower(trim(title)) || '|' || COALESCE(lower(trim(location)), '') AS key
         FROM roles
       ),
       open_keys AS (
         SELECT company_id, platform, key FROM k WHERE status = 'active'
         GROUP BY company_id, platform, key HAVING COUNT(*) = 1
       )
       SELECT a.id, MIN(b.first_seen_at) AS original, COUNT(b.id) AS n
       FROM k a
       JOIN open_keys o ON o.company_id = a.company_id AND o.platform = a.platform AND o.key = a.key
       JOIN k b ON b.company_id = a.company_id AND b.platform = a.platform AND b.key = a.key
         AND b.id <> a.id AND b.status = 'closed'
         AND b.last_seen_at <= datetime(a.first_seen_at, '+1 day')
         AND b.last_seen_at >= datetime(a.first_seen_at, '-180 days')
       WHERE a.status = 'active'
       GROUP BY a.id
       HAVING n = 1`,
    )
    .all() as Array<{ id: number; original: string }>;
  return new Map(rows.map((r) => [r.id, sqliteToIso(r.original)]));
}
