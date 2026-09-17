/**
 * export/exportMapData.ts
 * Reads geocoded companies and their active roles out of SQLite and writes
 * a single static JSON file the frontend fetches at runtime. Kept as a
 * separate export step (rather than the frontend querying SQLite directly,
 * which isn't possible from a browser) so the site can be a plain static
 * build — no backend server to host or keep running, just a JSON file that
 * gets regenerated after every daily sync.
 *
 * Deliberately excludes each role's full description (can run to 4000
 * chars) — Phase 1 only needs enough to plot a pin and list open roles;
 * the full posting is one click away via role.url, and a richer per-role
 * dossier is Phase 2's job, not this export's.
 *
 * Two adjustments happen here rather than at geocode time, because both
 * are display concerns, not facts about the company:
 *
 *   1. City-level geocoding (server/ingestion/geocode.ts) returns the same
 *      exact coordinate for every company in the same city — Nominatim
 *      geocodes "San Francisco, CA, USA" to one fixed point regardless of
 *      which company asked. Left as-is, every SF company would stack on
 *      the identical pixel, which both looks like "one dot" at low zoom
 *      and makes individual companies unclickable even fully zoomed in
 *      (they're pixel-identical, so a click only ever hits the topmost
 *      one). Companies sharing a coordinate get spread into a small ring
 *      around that city center, stable per company id, so each has its
 *      own clickable position. The database's stored latitude/longitude
 *      stay untouched — this jitter exists only in the exported JSON.
 *   2. A role whose own `location` string doesn't match the company's
 *      pin city is flagged `differentOffice: true`, so the frontend can
 *      make clear that role isn't at the pinned location (e.g. Fictiv's
 *      Illinois pin listing a role that's actually in Oakland, CA).
 *
 * Usage: npm run export
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDb } from "../db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "public", "data", "map-data.json");

// Degrees of latitude for the jitter ring's radius (~1.5km) — enough to
// separate pins visibly at city zoom without misrepresenting the area.
const JITTER_RADIUS_DEG = 0.014;

interface RoleExport {
  id: number;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  url: string | null;
  postedAt: string | null;
  differentOffice: boolean;
}

interface CompanyExport {
  id: number;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  roleCount: number;
  roles: RoleExport[];
}

interface CompanyRow {
  id: number;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
}

/** Spreads companies that share an exact coordinate into a small ring around it. */
function jitterSharedCoordinates(companies: CompanyRow[]): Map<number, { lat: number; lng: number }> {
  const groups = new Map<string, CompanyRow[]>();
  for (const c of companies) {
    const key = `${c.latitude},${c.longitude}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const jittered = new Map<number, { lat: number; lng: number }>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      jittered.set(group[0].id, { lat: group[0].latitude, lng: group[0].longitude });
      continue;
    }
    // Stable order (by id) so re-running the export doesn't shuffle pins.
    const sorted = [...group].sort((a, b) => a.id - b.id);
    const latRad = (sorted[0].latitude * Math.PI) / 180;
    sorted.forEach((c, i) => {
      const angle = (2 * Math.PI * i) / sorted.length;
      const dLat = JITTER_RADIUS_DEG * Math.cos(angle);
      // Longitude degrees compress toward the poles; correct so the ring
      // looks circular rather than elliptical.
      const dLng = (JITTER_RADIUS_DEG * Math.sin(angle)) / Math.cos(latRad);
      jittered.set(c.id, { lat: c.latitude + dLat, lng: c.longitude + dLng });
    });
  }
  return jittered;
}

/** True if a role's own location string doesn't mention the company's pinned city. */
function isDifferentOffice(roleLocation: string | null, companyCity: string | null): boolean {
  if (!roleLocation || !companyCity) return false;
  return !roleLocation.toLowerCase().includes(companyCity.toLowerCase());
}

function main() {
  const db = getDb();

  const companies = db
    .prepare(
      `SELECT id, name, slug, city, state, latitude, longitude
       FROM companies
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    )
    .all() as CompanyRow[];

  const jitteredCoords = jitterSharedCoordinates(companies);

  const getRoles = db.prepare(
    `SELECT id, title, location, salary_min, salary_max, salary_currency, url, posted_at
     FROM roles
     WHERE company_id = ? AND status = 'active'
     ORDER BY posted_at DESC`,
  );

  const result: CompanyExport[] = [];
  let totalRoles = 0;

  for (const company of companies) {
    const roles = getRoles.all(company.id) as Array<{
      id: number;
      title: string;
      location: string | null;
      salary_min: number | null;
      salary_max: number | null;
      salary_currency: string | null;
      url: string | null;
      posted_at: string | null;
    }>;

    // A geocoded company with zero currently-active roles shouldn't get a
    // pin — its office was real once, but there's nothing to show there
    // now (e.g. its only postings closed since the last geocode pass).
    if (roles.length === 0) continue;

    const coord = jitteredCoords.get(company.id) ?? { lat: company.latitude, lng: company.longitude };

    result.push({
      id: company.id,
      name: company.name,
      slug: company.slug,
      city: company.city,
      state: company.state,
      latitude: coord.lat,
      longitude: coord.lng,
      roleCount: roles.length,
      roles: roles.map((r) => ({
        id: r.id,
        title: r.title,
        location: r.location,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        url: r.url,
        postedAt: r.posted_at,
        differentOffice: isDifferentOffice(r.location, company.city),
      })),
    });
    totalRoles += roles.length;
  }

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        companyCount: result.length,
        roleCount: totalRoles,
        companies: result,
      },
      null,
      2,
    ),
  );

  console.log(`Exported ${result.length} companies / ${totalRoles} roles to ${OUTPUT_PATH}`);
}

main();
