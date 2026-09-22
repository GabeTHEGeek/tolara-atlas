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
 * Reads from role_locations, not roles.latitude/longitude directly. A
 * single ATS posting can itself be open across several offices at once
 * (e.g. one Greenhouse listing for "Menlo Park, CA; New York, NY;
 * Washington, DC"); server/ingestion/geocode.ts resolves every office it
 * finds in a role's raw location string into its own role_locations row,
 * so a role like that contributes to a pin in each city, not just
 * whichever one happened to be geocoded first. Each pin's own roleCount
 * reflects only the roles actually posted at that pin's city, but the
 * top-level roleCount in the exported JSON is deliberately deduped back
 * down to distinct roles.id -- a role open in 3 offices still counts as
 * 1 role site-wide, even though it appears in 3 pins.
 *
 * A role whose posting has no resolvable office at all (e.g. "Remote -
 * USA") still gets a role_locations row, courtesy of geocode.ts's remote
 * fallback -- it's pinned at its own company's dominant office rather than
 * dropped. Each such role's isRemote flag carries through to the exported
 * RoleExport so the frontend can call it out (e.g. "2 of these are
 * remote") instead of presenting it as an ordinary office posting.
 *
 * A remaining display concern, unrelated to which office a role belongs
 * to: geocoding is city-level (server/ingestion/geocode.ts), so pins that
 * happen to land on the exact same coordinate (e.g. two different
 * companies' "San Francisco, CA" pins) get spread into a small ring
 * around that point so each stays individually visible and clickable.
 * This jitter exists only in the exported JSON — stored lat/lng on the
 * roles table stay untouched.
 *
 * A small number of active roles have NO resolvable location anywhere --
 * not in their own posting text, not in their company's dominant office,
 * not in their company's wider board, not in a curated HQ (see
 * geocode.ts's three-tier fallback). These get no role_locations row at
 * all, so they're invisible to the query above and never become a pin --
 * there's genuinely no city to put one at, and geocode.ts deliberately
 * doesn't fabricate one. Rather than drop them from the export entirely,
 * they're gathered separately into `remoteCompanies`, grouped by company,
 * for the frontend to show in an unmapped list (e.g. a "Remote-first
 * companies" panel) instead of a map pin -- so a genuinely remote-only
 * company's roles are still findable, just not misrepresented as sitting
 * in any particular city.
 *
 * Usage: npm run export
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDb } from "../db/client.js";
import { isExplicitlyNonUS } from "../ingestion/locationParser.js";
import { writeCompanyDetails } from "./companyDetails.js";
import { NEW_ROLE_DAYS, isNewRole, seniorityOf, sqliteToIso, type Seniority } from "./roleFacets.js";

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
  // 'year' | 'hour' | 'month' -- what the figures are per. Never converted;
  // see server/ingestion/salary.ts.
  salaryPeriod: string | null;
  url: string | null;
  postedAt: string | null;
  // When our sync first saw this posting. Distinct from postedAt, which is
  // the board's own date and is missing on plenty of postings -- firstSeenAt
  // is always present, so it's what the "posted within" filter falls back to.
  firstSeenAt: string;
  isNew: boolean;
  // Derived from the title (see roleFacets.ts) -- the only seniority signal
  // an ATS gives us for free.
  seniority: Seniority;
  // true when this role has no resolvable office of its own (its posting's
  // location was something like "Remote - USA") and is pinned here only
  // because it's the company's dominant office -- see geocode.ts. false
  // for a role genuinely posted at this pin's city.
  isRemote: boolean;
}

/**
 * What moved since the last sync window, so the map can say "9 added, 3
 * closed" instead of silently changing under you. Everything here comes
 * from columns the sync already maintains: first_seen_at, and the
 * last_seen_at stamp left behind when a posting stops appearing on its
 * board and sync.ts flips it to status='closed'.
 *
 * `closed` is the true count in the window; `closedRoles` is capped, since
 * this file loads on every visit and a big purge shouldn't bloat it.
 */
interface ClosedRoleExport {
  id: number;
  title: string;
  companyName: string;
  companySlug: string;
  city: string | null;
  state: string | null;
  url: string | null;
  closedAt: string;
}

interface ChangeFeedExport {
  windowDays: number;
  since: string;
  added: number;
  closed: number;
  closedRoles: ClosedRoleExport[];
  lastSync: { finishedAt: string | null; status: string } | null;
}

const CLOSED_ROLE_LIMIT = 200;

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

// A company with at least one active role that has no resolvable location
// anywhere (see the header comment above) -- no lat/lng, since there's no
// city to place one at.
interface RemoteCompanyExport {
  companyId: number;
  companyName: string;
  companySlug: string;
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
  salary_period: string | null;
  url: string | null;
  posted_at: string | null;
  first_seen_at: string;
  resolved_city: string | null;
  resolved_state: string | null;
  latitude: number;
  longitude: number;
  is_remote: number;
}

// One row per (role, office), from role_locations -- a role open in
// several offices at once produces one of these per office, so it can
// contribute to a pin at each one instead of just its first-listed city.
interface RoleLocationRow extends RoleRow {
  location_id: number;
}

function slugifyLocation(city: string, state: string): string {
  return `${city}-${state}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministic 32-bit string hash (FNV-1a), used to seed each pin's jitter. */
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny seeded PRNG (mulberry32) — deterministic per seed, so re-running the export doesn't reshuffle pins. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spreads pins that share an exact coordinate into a small cloud around it.
 * Each pin's offset (angle + distance) is derived from a hash of its own id
 * rather than its index in the group — an evenly-divided ring (angle =
 * 2π × i/count) reads as an obviously artificial perfect circle once you
 * zoom in close enough to see it, which undermines trust in the map ("why
 * are these dots arranged in a circle in the harbor?"). A per-pin random
 * angle and radius looks organic instead, while staying stable across
 * re-exports since it's seeded by the pin's own id, not group order.
 */
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
    const latRad = (group[0].latitude * Math.PI) / 180;
    for (const p of group) {
      const rand = mulberry32(hashString(p.id));
      const angle = rand() * 2 * Math.PI;
      const radiusFrac = 0.45 + rand() * 0.55; // avoid a hollow-center look
      const dLat = JITTER_RADIUS_DEG * radiusFrac * Math.cos(angle);
      const dLng = (JITTER_RADIUS_DEG * radiusFrac * Math.sin(angle)) / Math.cos(latRad);
      jittered.set(p.id, { lat: p.latitude + dLat, lng: p.longitude + dLng });
    }
  }
  return jittered;
}

/**
 * The shared columns every exported role needs. RoleRow (mapped pins) and
 * the unplaced-role query (the unmapped list) both satisfy this, so both
 * paths produce identically-shaped roles.
 */
interface RoleExportSource {
  id: number;
  title: string;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  url: string | null;
  posted_at: string | null;
  first_seen_at: string;
}

function toRoleExport(row: RoleExportSource, trackedSince: string, now: number, isRemote: boolean): RoleExport {
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    salaryPeriod: row.salary_period,
    url: row.url,
    postedAt: row.posted_at,
    firstSeenAt: sqliteToIso(row.first_seen_at),
    isNew: isNewRole(row, trackedSince, now),
    seniority: seniorityOf(row.title),
    isRemote,
  };
}

/**
 * Roles that stopped appearing on their board and were closed inside the
 * window, newest first. sync.ts sets status='closed' a day after a posting
 * last showed up, so last_seen_at is the closest thing we have to "when it
 * came down" -- it's the last time we saw it alive, not a board-supplied
 * close date, and the UI says "last seen" rather than "closed on" for that
 * reason.
 */
function buildChangeFeed(db: ReturnType<typeof getDb>, now: number): ChangeFeedExport {
  const since = new Date(now - NEW_ROLE_DAYS * 86_400_000).toISOString();
  const window = `-${NEW_ROLE_DAYS} days`;

  const closedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM roles
         WHERE status = 'closed' AND last_seen_at >= datetime('now', ?)`,
      )
      .get(window) as { n: number }
  ).n;

  const closedRows = db
    .prepare(
      `SELECT roles.id, roles.title, roles.url, roles.last_seen_at,
              roles.resolved_city, roles.resolved_state,
              companies.name AS company_name, companies.slug AS company_slug
       FROM roles JOIN companies ON companies.id = roles.company_id
       WHERE roles.status = 'closed' AND roles.last_seen_at >= datetime('now', ?)
       ORDER BY roles.last_seen_at DESC
       LIMIT ?`,
    )
    .all(window, CLOSED_ROLE_LIMIT) as Array<{
    id: number;
    title: string;
    url: string | null;
    last_seen_at: string;
    resolved_city: string | null;
    resolved_state: string | null;
    company_name: string;
    company_slug: string;
  }>;

  const lastSyncRow = db
    .prepare(
      `SELECT status, finished_at FROM sync_runs
       WHERE status != 'running' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { status: string; finished_at: string | null } | undefined;

  return {
    windowDays: NEW_ROLE_DAYS,
    since,
    // Filled in by main() once the visible roles are known -- "added" has to
    // mean "new AND actually on the map", not "new in the database".
    added: 0,
    closed: closedCount,
    closedRoles: closedRows.map((r) => ({
      id: r.id,
      title: r.title.trim(),
      companyName: r.company_name,
      companySlug: r.company_slug,
      city: r.resolved_city,
      state: r.resolved_state,
      url: r.url,
      closedAt: sqliteToIso(r.last_seen_at),
    })),
    lastSync: lastSyncRow ? { finishedAt: lastSyncRow.finished_at ? sqliteToIso(lastSyncRow.finished_at) : null, status: lastSyncRow.status } : null,
  };
}

function main() {
  const db = getDb();
  const now = Date.now();

  // When we first saw ANY role at each company -- the baseline isNewRole
  // needs so a company added yesterday doesn't report its whole board as
  // new (see roleFacets.ts).
  const trackedSinceByCompany = new Map<number, string>(
    (
      db.prepare(`SELECT company_id, MIN(first_seen_at) AS t FROM roles GROUP BY company_id`).all() as Array<{
        company_id: number;
        t: string;
      }>
    ).map((r) => [r.company_id, sqliteToIso(r.t)]),
  );
  const trackedSince = (companyId: number) => trackedSinceByCompany.get(companyId) ?? new Date(now).toISOString();

  // Reads from role_locations (one row per office a role is actually open
  // in), not roles.latitude/longitude directly -- a role listed as open in
  // several offices at once (one Greenhouse/Ashby/Lever posting, several
  // cities in its location string) needs to contribute a pin at EACH of
  // them, not just whichever city geocode.ts saw first.
  const rows = db
    .prepare(
      `SELECT
         role_locations.id AS location_id,
         roles.id, roles.company_id, companies.name AS company_name, companies.slug AS company_slug,
         roles.title, roles.location, roles.salary_min, roles.salary_max, roles.salary_currency, roles.salary_period,
         roles.url, roles.posted_at, roles.first_seen_at,
         role_locations.resolved_city, role_locations.resolved_state,
         role_locations.latitude, role_locations.longitude, role_locations.is_remote
       FROM role_locations
       JOIN roles ON roles.id = role_locations.role_id
       JOIN companies ON companies.id = roles.company_id
       WHERE roles.status = 'active'
       ORDER BY roles.posted_at DESC`,
    )
    .all() as RoleLocationRow[];

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
      roles: p.roles.map((r) => toRoleExport(r, trackedSince(p.companyId), now, Boolean(r.is_remote))),
    };
  });

  // Active roles with no role_locations row at all -- geocode.ts's three
  // fallback tiers all came up empty for these (no office of their own, no
  // company dominant office, no board-wide office, no curated HQ). Not a
  // subset of `rows` above; this is the complement of it.
  const unplacedRows = db
    .prepare(
      `SELECT
         roles.id, roles.company_id, companies.name AS company_name, companies.slug AS company_slug,
         roles.title, roles.location, roles.salary_min, roles.salary_max, roles.salary_currency, roles.salary_period,
         roles.url, roles.posted_at, roles.first_seen_at
       FROM roles
       JOIN companies ON companies.id = roles.company_id
       LEFT JOIN role_locations ON role_locations.role_id = roles.id
       WHERE roles.status = 'active' AND role_locations.id IS NULL
       ORDER BY roles.posted_at DESC`,
    )
    .all() as Array<{
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
    first_seen_at: string;
    salary_period: string | null;
  }>;

  // geocode.ts's fallback tiers already exclude a role whose own location
  // text explicitly names a non-US place (see isExplicitlyNonUS) from
  // getting pinned at a US office -- but a role can still show up here from
  // BEFORE that fix ran, if it was left with a stale role_locations row from
  // the old behavior and hasn't been re-geocoded since, or from any other
  // path that reaches this query. Filtering again here, right before the
  // unmapped/"remote" panel is built, means a French or Spanish posting
  // never gets shown to a US job-seeker mislabeled as "remote" even if the
  // DB itself hasn't been fully cleaned up yet.
  const usUnplacedRows = unplacedRows.filter((r) => !isExplicitlyNonUS(r.location));

  const remoteCompaniesByCompany = new Map<
    number,
    { companyId: number; companyName: string; companySlug: string; roles: RoleExport[] }
  >();
  for (const row of usUnplacedRows) {
    const existing = remoteCompaniesByCompany.get(row.company_id);
    const roleExport: RoleExport = toRoleExport(row, trackedSince(row.company_id), now, true);
    if (existing) {
      existing.roles.push(roleExport);
    } else {
      remoteCompaniesByCompany.set(row.company_id, {
        companyId: row.company_id,
        companyName: row.company_name,
        companySlug: row.company_slug,
        roles: [roleExport],
      });
    }
  }

  const remoteCompanies: RemoteCompanyExport[] = [...remoteCompaniesByCompany.values()]
    .map((c) => ({ ...c, roleCount: c.roles.length }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName));

  // companyCount/roleCount cover every active role, whether it landed on
  // the map or in the unmapped remoteCompanies list -- a company with only
  // unplaceable roles still counts as a company with open roles, and those
  // roles are still real openings, just not pinnable anywhere.
  const companyCount = new Set([...pins.map((p) => p.companyId), ...remoteCompanies.map((c) => c.companyId)]).size;
  // Distinct roles, not (role, office) pairs -- a role open in 3 offices
  // adds 1 here even though it contributes to 3 pins' individual
  // roleCount. rows is one row per role_locations entry, so the same
  // role.id can repeat; dedupe by id for the headline total.
  const roleCount = new Set(rows.map((r) => r.id)).size + usUnplacedRows.length;

  const changes = buildChangeFeed(db, now);
  // Distinct role ids, for the same reason roleCount dedupes: a new role
  // open in 3 offices is one new role, not three.
  changes.added = new Set(
    [...pins.flatMap((p) => p.roles), ...remoteCompanies.flatMap((c) => c.roles)]
      .filter((r) => r.isNew)
      .map((r) => r.id),
  ).size;

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        companyCount,
        pinCount: pins.length,
        roleCount,
        changes,
        pins,
        remoteCompanies,
      },
      null,
      2,
    ),
  );

  // Per-company files for the role pages, covering exactly the roles the
  // map and the unmapped list show.
  const visibleRoleIds = new Set([...rows.map((r) => r.id), ...usUnplacedRows.map((r) => r.id)]);
  const detailFiles = writeCompanyDetails(db, path.join(path.dirname(OUTPUT_PATH), "companies"), visibleRoleIds);
  console.log(`Wrote ${detailFiles} company detail files to ${path.join(path.dirname(OUTPUT_PATH), "companies")}`);

  console.log(
    `Change feed: ${changes.added} added, ${changes.closed} closed in the last ${changes.windowDays} days`,
  );

  const nonUsFiltered = unplacedRows.length - usUnplacedRows.length;
  console.log(
    `Exported ${pins.length} pins across ${companyCount} companies / ${roleCount} roles to ${OUTPUT_PATH} ` +
      `(${remoteCompanies.length} companies / ${usUnplacedRows.length} roles with no resolvable location, shown unmapped` +
      (nonUsFiltered > 0 ? `; ${nonUsFiltered} additional roles excluded as explicitly non-US)` : ")"),
  );
}

main();
