/**
 * enrichment/intelligence.ts
 * On-demand company/role intelligence behind the role page's "Load company
 * intelligence" button. Nothing here runs in the daily sync -- it only
 * fetches for the one company and role someone actually opens, then caches
 * the result so the next click (and the next static export) reuses it.
 *
 * Cache lives in the schema's existing enrichment tables:
 *   company_enrichments kind 'profile'    -- Wikidata snapshot, refreshed after 30 days
 *   company_enrichments kind 'leadership' -- Wikidata CEO(s), same cadence
 *   company_enrichments kind 'news'       -- Google News headlines, refreshed after 2 days
 *   role_enrichments    kind 'focus_summary' -- posting bullets, reused until the
 *                                               role's content_hash changes
 * "Not found" is cached too (as found: false), so an unknown startup isn't
 * looked up again on every click.
 */

import type Database from "better-sqlite3";
import { fetchWikidataCompany, type CompanyProfile, type Leader } from "./wikidata.js";
import { fetchCompanyNews, type NewsItem } from "./news.js";
import { fetchRoleFocus, type RoleFocus } from "./roleFocus.js";

const PROFILE_TTL_DAYS = 30;

// SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC.
function sqliteToIso(ts: string): string {
  return new Date(`${ts.replace(" ", "T")}Z`).toISOString();
}
const NEWS_TTL_DAYS = 2;

export interface CompanyIntelligence {
  profile: CompanyProfile | null;
  leaders: Leader[];
  news: NewsItem[];
  focus: RoleFocus | null;
  fetchedAt: string; // oldest of the pieces returned
}

interface CachedRow {
  data: string;
  fetched_at: string;
  fresh: number;
}

function readCompanyCache(db: Database.Database, companyId: number, kind: string): (CachedRow & { value: unknown }) | null {
  const row = db
    .prepare(
      `SELECT data, fetched_at, (refresh_after IS NULL OR refresh_after > datetime('now')) AS fresh
       FROM company_enrichments WHERE company_id = ? AND kind = ?`,
    )
    .get(companyId, kind) as CachedRow | undefined;
  return row ? { ...row, value: JSON.parse(row.data) } : null;
}

function writeCompanyCache(
  db: Database.Database,
  companyId: number,
  kind: string,
  value: unknown,
  sourceUrl: string | null,
  ttlDays: number,
) {
  db.prepare(
    `INSERT INTO company_enrichments (company_id, kind, data, source_url, fetched_at, refresh_after)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now', ?))
     ON CONFLICT (company_id, kind) DO UPDATE SET
       data = excluded.data, source_url = excluded.source_url,
       fetched_at = excluded.fetched_at, refresh_after = excluded.refresh_after`,
  ).run(companyId, kind, JSON.stringify(value), sourceUrl, `+${ttlDays} days`);
}

/** Cached intelligence only -- no network. What the static export bakes in. */
export function readCachedIntelligence(
  db: Database.Database,
  companyId: number,
  roleId: number | null,
): Omit<CompanyIntelligence, "fetchedAt"> & { fetchedAt: string | null } | null {
  const profile = readCompanyCache(db, companyId, "profile");
  const leadership = readCompanyCache(db, companyId, "leadership");
  const news = readCompanyCache(db, companyId, "news");
  const focus = roleId == null ? null : readRoleFocusCache(db, roleId);
  if (!profile && !news && !focus) return null;
  const profileValue = profile?.value as { found: boolean; profile?: CompanyProfile } | undefined;
  const times = [profile?.fetched_at, news?.fetched_at].filter((t): t is string => Boolean(t)).sort();
  return {
    profile: profileValue?.found ? profileValue.profile ?? null : null,
    leaders: (leadership?.value as Leader[] | undefined) ?? [],
    news: (news?.value as NewsItem[] | undefined) ?? [],
    focus: focus?.focus ?? null,
    fetchedAt: times[0] ? sqliteToIso(times[0]) : null,
  };
}

function readRoleFocusCache(
  db: Database.Database,
  roleId: number,
): { focus: RoleFocus | null; contentHash: string } | null {
  const row = db
    .prepare(`SELECT data FROM role_enrichments WHERE role_id = ? AND kind = 'focus_summary'`)
    .get(roleId) as { data: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.data) as { focus: RoleFocus | null; contentHash: string };
  return parsed;
}

function writeRoleFocusCache(db: Database.Database, roleId: number, focus: RoleFocus | null, contentHash: string) {
  db.prepare(
    `INSERT INTO role_enrichments (role_id, kind, data, fetched_at) VALUES (?, 'focus_summary', ?, datetime('now'))
     ON CONFLICT (role_id, kind) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(roleId, JSON.stringify({ focus, contentHash }));
}

/**
 * Intelligence for one company (and optionally one of its roles), fetching
 * only the pieces that are missing or stale. Returns null if the company
 * doesn't exist.
 */
export async function loadIntelligence(
  db: Database.Database,
  companySlug: string,
  roleId: number | null,
): Promise<CompanyIntelligence | null> {
  const company = db.prepare(`SELECT id, name FROM companies WHERE slug = ?`).get(companySlug) as
    | { id: number; name: string }
    | undefined;
  if (!company) return null;

  let profileEntry = readCompanyCache(db, company.id, "profile");
  if (!profileEntry?.fresh) {
    // Cities the company has offices in on our map, plus any hand-set HQ --
    // what a Wikidata match's headquarters is checked against.
    const officeCities = (
      db
        .prepare(
          `SELECT DISTINCT rl.resolved_city AS city FROM role_locations rl JOIN roles r ON r.id = rl.role_id
           WHERE r.company_id = ? AND r.status = 'active'
           UNION SELECT city FROM companies WHERE id = ? AND city IS NOT NULL`,
        )
        .all(company.id, company.id) as Array<{ city: string }>
    ).map((r) => r.city);
    const result = await fetchWikidataCompany(company.name, officeCities);
    writeCompanyCache(
      db,
      company.id,
      "profile",
      result ? { found: true, profile: result.profile } : { found: false },
      result?.profile.wikidataUrl ?? null,
      // A miss is re-checked sooner, in case the name gets fixed or Wikidata adds the company.
      result ? PROFILE_TTL_DAYS : 7,
    );
    writeCompanyCache(db, company.id, "leadership", result?.leaders ?? [], result?.profile.wikidataUrl ?? null, result ? PROFILE_TTL_DAYS : 7);
    profileEntry = readCompanyCache(db, company.id, "profile");
  }
  const leaders = (readCompanyCache(db, company.id, "leadership")?.value as Leader[] | undefined) ?? [];

  let newsEntry = readCompanyCache(db, company.id, "news");
  if (!newsEntry?.fresh) {
    const items = await fetchCompanyNews(company.name, leaders.map((l) => l.name));
    writeCompanyCache(db, company.id, "news", items, null, NEWS_TTL_DAYS);
    newsEntry = readCompanyCache(db, company.id, "news");
  }

  let focus: RoleFocus | null = null;
  if (roleId != null) {
    const role = db
      .prepare(
        `SELECT r.id, r.platform, r.source_job_id, r.content_hash,
                (SELECT token FROM company_sources s WHERE s.company_id = r.company_id AND s.platform = r.platform LIMIT 1) AS token
         FROM roles r WHERE r.id = ? AND r.company_id = ?`,
      )
      .get(roleId, company.id) as
      | { id: number; platform: string; source_job_id: string; content_hash: string; token: string | null }
      | undefined;
    if (role) {
      const cached = readRoleFocusCache(db, role.id);
      if (cached && cached.contentHash === role.content_hash) {
        focus = cached.focus;
      } else if (role.token) {
        focus = await fetchRoleFocus({
          platform: role.platform,
          sourceJobId: role.source_job_id,
          boardToken: role.token,
        });
        writeRoleFocusCache(db, role.id, focus, role.content_hash);
      }
    }
  }

  const profileValue = profileEntry?.value as { found: boolean; profile?: CompanyProfile } | undefined;
  const times = [profileEntry?.fetched_at, newsEntry?.fetched_at].filter((t): t is string => Boolean(t)).sort();
  return {
    profile: profileValue?.found ? profileValue.profile ?? null : null,
    leaders,
    news: (newsEntry?.value as NewsItem[] | undefined) ?? [],
    focus,
    fetchedAt: times[0] ? sqliteToIso(times[0]) : new Date().toISOString(),
  };
}
