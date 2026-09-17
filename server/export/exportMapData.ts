/**
 * export/exportMapData.ts
 * Reads geocoded, active roles out of SQLite and writes a single static
 * JSON file the frontend fetches at runtime. Kept as a separate export
 * step (rather than the frontend querying SQLite directly, which isn't
 * possible from a browser) so the site can be a plain static build — no
 * backend server to host or keep running, just a JSON file that gets
 * regenerated after every daily sync.
 *
 * Deliberately excludes each role's full description (can run to 4000
 * chars) — Phase 1 only needs enough to plot a pin and list open roles;
 * the full posting is one click away via role.url, and a richer per-role
 * dossier is Phase 2's job, not this export's.
 *
 * One pin per (company, resolved location) — NOT one pin per company. A
 * company with active roles in more than one city gets a pin in each city,
 * and each pin only lists the roles actually posted there. This replaced
 * an earlier "one pin per company, most frequent location wins" design,
 * which both hid multi-office companies under a single city and, with
 * small posting counts, could mislabel which office looked "primary."
 *
 * A remaining display concern, unrelated to which office a role belongs
 * to: geocoding is city-level (server/ingestion/geocode.ts), so pins that
 * happen to land on the exact same coordinate (e.g. two different
 * companies' "San Francisco, CA" pins) get spread into a small ring
 * around that point so each stays individually visible and clickable.
 * This jitter exists only in the exported JSON — stored lat/lng on the
 * roles table stay untouched.
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
}

interface PinExport {
  id: string;
  companyId: number;
  companyName: string;
  companySlug: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  roleCount: number;
  roles: RoleExport[];
}

interface RoleRow {
  id: number;
  company_id: number;
  company_name: string;
  company_slug: string;
  title: string;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  url: string | null;
  posted_at: string | null;
  resolved_city: string | null;
  resolved_state: string | null;
  latitude: number;
  longitude: number;
}

function slugifyLocation(city: string, state: string): string {
  return `${city}-${state}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Spreads pins that share an exact coordinate into a small ring around it. */
function jitterSharedCoordinates(
  pins: Array<{ id: string; latitude: number; longitude: number }>,
): Map<string, { lat: number; lng: number }> {
  const groups = new Map<string, typeof pins>();
  for (const p of pins) {
    const key = `${p.latitude},${p.longitude}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const jittered = new Map<string, { lat: number; lng: number }>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      jittered.set(group[0].id, { lat: group[0].latitude, lng: group[0].longitude });
      continue;
    }
    // Stable order (by id) so re-running the export doesn't shuffle pins.
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const latRad = (sorted[0].latitude * Math.PI) / 180;
    sorted.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / sorted.length;
      const dLat = JITTER_RADIUS_DEG * Math.cos(angle);
      const dLng = (JITTER_RADIUS_DEG * Math.sin(angle)) / Math.cos(latRad);
      jittered.set(p.id, { lat: p.latitude + dLat, lng: p.longitude + dLng });
    });
  }
  return jittered;
}

function main() {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
         roles.id, roles.company_id, companies.name AS company_name, companies.slug AS company_slug,
         roles.title, roles.location, roles.salary_min, roles.salary_max, roles.salary_currency,
         roles.url, roles.posted_at, roles.resolved_city, roles.resolved_state, roles.latitude, roles.longitude
       FROM roles
       JOIN companies ON companies.id = roles.company_id
       WHERE roles.status = 'active' AND roles.latitude IS NOT NULL AND roles.longitude IS NOT NULL
       ORDER BY roles.posted_at DESC`,
    )
    .all() as RoleRow[];

  // Group roles into pins keyed by (company, resolved city/state).
  const pinsByKey = new Map<
    string,
    { companyId: number; companyName: string; companySlug: string; city: string; state: string; latitude: number; longitude: number; roles: RoleRow[] }
  >();

  for (const row of rows) {
    const city = row.resolved_city ?? "Unknown";
    const state = row.resolved_state ?? "";
    const key = `${row.company_id}|${city}|${state}`;
    const existing = pinsByKey.get(key);
    if (existing) {
      existing.roles.push(row);
    } else {
      pinsByKey.set(key, {
        companyId: row.company_id,
        companyName: row.company_name,
        companySlug: row.company_slug,
        city,
        state,
        latitude: row.latitude,
        longitude: row.longitude,
        roles: [row],
      });
    }
  }

  const pinList = [...pinsByKey.values()].map((p) => ({
    id: `${p.companyId}-${slugifyLocation(p.city, p.state)}`,
    ...p,
  }));

  const jitteredCoords = jitterSharedCoordinates(pinList);

  const pins: PinExport[] = pinList.map((p) => {
    const coord = jitteredCoords.get(p.id) ?? { lat: p.latitude, lng: p.longitude };
    return {
      id: p.id,
      companyId: p.companyId,
      companyName: p.companyName,
      companySlug: p.companySlug,
      city: p.city,
      state: p.state,
      latitude: coord.lat,
      longitude: coord.lng,
      roleCount: p.roles.length,
      roles: p.roles.map((r) => ({
        id: r.id,
        title: r.title,
        location: r.location,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        url: r.url,
        postedAt: r.posted_at,
      })),
    };
  });

  const companyCount = new Set(pins.map((p) => p.companyId)).size;
  const roleCount = pins.reduce((sum, p) => sum + p.roleCount, 0);

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        companyCount,
        pinCount: pins.length,
        roleCount,
        pins,
      },
      null,
      2,
    ),
  );

  console.log(
    `Exported ${pins.length} pins across ${companyCount} companies / ${roleCount} roles to ${OUTPUT_PATH}`,
  );
}

main();
