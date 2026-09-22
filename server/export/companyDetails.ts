/**
 * export/companyDetails.ts
 * One JSON file per company (public/data/companies/<slug>.json) for the
 * role page: every role of theirs that the site shows, the offices each is
 * pinned at, hiring signals computed from our own sync history, and any
 * company intelligence already cached by an earlier "Load company
 * intelligence" click -- so a company someone has looked up before renders
 * complete with no request at all.
 *
 * Kept out of map-data.json on purpose: that file loads on every visit,
 * these load only when someone opens a role.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { readCachedIntelligence } from "../enrichment/intelligence.js";
import {
  NEW_ROLE_DAYS,
  daysSince,
  isNewRole,
  seniorityOf,
  sqliteToIso,
  type Seniority,
} from "./roleFacets.js";

export interface CompanyDetailsOffice {
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  isRemote: boolean;
}

export interface CompanyDetailsRole {
  id: number;
  title: string;
  team: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  url: string | null;
  postedAt: string | null;
  firstSeenAt: string; // ISO; when our sync first saw it
  isNew: boolean;
  seniority: Seniority;
  offices: CompanyDetailsOffice[];
  focus: { bullets: string[]; method: "posting" } | null;
}

export interface HiringSignal {
  text: string;
  tone: "positive" | "neutral" | "caution";
  detail: string;
}

interface RoleRow {
  id: number;
  title: string;
  category: string | null;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  url: string | null;
  posted_at: string | null;
  first_seen_at: string;
}

function companySignals(roles: CompanyDetailsRole[], trackedSince: string, now: number): HiringSignal[] {
  const signals: HiringSignal[] = [];
  const offices = new Set(roles.flatMap((r) => r.offices.filter((o) => !o.isRemote).map((o) => `${o.city}|${o.state}`)));
  signals.push({
    text:
      `${roles.length} open PM ${roles.length === 1 ? "role" : "roles"}` +
      (offices.size > 0 ? ` across ${offices.size} US ${offices.size === 1 ? "office" : "offices"}` : ""),
    tone: roles.length >= 3 ? "positive" : "neutral",
    detail: "now",
  });

  const trackedDays = daysSince(trackedSince, now);
  if (trackedDays > NEW_ROLE_DAYS) {
    const recent = roles.filter((r) => daysSince(r.firstSeenAt, now) <= NEW_ROLE_DAYS).length;
    if (recent > 0) {
      signals.push({ text: `${recent} new PM ${recent === 1 ? "role" : "roles"} posted this week`, tone: "positive", detail: "last 7 days" });
    }
  } else {
    signals.push({ text: "Recently added to Tolara — hiring trends need a week of history", tone: "neutral", detail: "tracking" });
  }
  return signals;
}

export function writeCompanyDetails(db: Database.Database, outputDir: string, visibleRoleIds: Set<number>) {
  const now = Date.now();
  const companies = db
    .prepare(
      `SELECT DISTINCT c.id, c.name, c.slug, c.created_at
       FROM companies c JOIN roles r ON r.company_id = c.id
       WHERE r.status = 'active'`,
    )
    .all() as Array<{ id: number; name: string; slug: string; created_at: string }>;

  const rolesFor = db.prepare(
    `SELECT id, title, category, location, salary_min, salary_max, salary_currency, salary_period, url, posted_at, first_seen_at
     FROM roles WHERE company_id = ? AND status = 'active'
     ORDER BY COALESCE(posted_at, first_seen_at) DESC`,
  );
  const officesFor = db.prepare(
    `SELECT resolved_city, resolved_state, latitude, longitude, is_remote FROM role_locations WHERE role_id = ?`,
  );
  const trackedSinceFor = db.prepare(`SELECT MIN(first_seen_at) AS t FROM roles WHERE company_id = ?`);

  // Rewrite the folder wholesale so companies that dropped off the map
  // don't leave stale files behind.
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  let written = 0;
  for (const company of companies) {
    const rows = (rolesFor.all(company.id) as RoleRow[]).filter((r) => visibleRoleIds.has(r.id));
    if (rows.length === 0) continue;

    const trackedRow = trackedSinceFor.get(company.id) as { t: string | null };
    const trackedSince = sqliteToIso(trackedRow.t ?? company.created_at);

    const roles: CompanyDetailsRole[] = rows.map((r) => {
      const cached = readCachedIntelligence(db, company.id, r.id);
      return {
        id: r.id,
        title: r.title.trim(),
        team: r.category?.trim() || null,
        location: r.location,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        salaryPeriod: r.salary_period,
        url: r.url,
        postedAt: r.posted_at,
        firstSeenAt: sqliteToIso(r.first_seen_at),
        isNew: isNewRole(r, trackedSince, now),
        seniority: seniorityOf(r.title),
        offices: (
          officesFor.all(r.id) as Array<{
            resolved_city: string;
            resolved_state: string;
            latitude: number;
            longitude: number;
            is_remote: number;
          }>
        ).map((o) => ({
          city: o.resolved_city,
          state: o.resolved_state,
          latitude: o.latitude,
          longitude: o.longitude,
          isRemote: Boolean(o.is_remote),
        })),
        focus: cached?.focus ?? null,
      };
    });

    const cached = readCachedIntelligence(db, company.id, null);
    const details = {
      generatedAt: new Date(now).toISOString(),
      company: { id: company.id, name: company.name, slug: company.slug, trackedSince },
      signals: companySignals(roles, trackedSince, now),
      intelligence: cached
        ? { profile: cached.profile, leaders: cached.leaders, news: cached.news, fetchedAt: cached.fetchedAt }
        : null,
      roles,
    };
    writeFileSync(path.join(outputDir, `${company.slug}.json`), JSON.stringify(details));
    written += 1;
  }
  return written;
}

