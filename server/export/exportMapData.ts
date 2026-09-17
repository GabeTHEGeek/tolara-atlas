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
 * Usage: npm run export
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDb } from "../db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "..", "public", "data", "map-data.json");

interface RoleExport {
  id: number;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  url: string | null;
  postedAt: string | null;
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

function main() {
  const db = getDb();

  const companies = db
    .prepare(
      `SELECT id, name, slug, city, state, latitude, longitude
       FROM companies
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    )
    .all() as Array<{
    id: number;
    name: string;
    slug: string;
    city: string | null;
    state: string | null;
    latitude: number;
    longitude: number;
  }>;

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

    result.push({
      id: company.id,
      name: company.name,
      slug: company.slug,
      city: company.city,
      state: company.state,
      latitude: company.latitude,
      longitude: company.longitude,
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
