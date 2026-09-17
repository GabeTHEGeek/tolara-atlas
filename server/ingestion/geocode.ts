/**
 * ingestion/geocode.ts
 * Resolves each ACTIVE ROLE's own location string to one or more
 * city/state + lat/lng pairs — not the company's, and not just the first
 * one mentioned. A single posting is frequently open in SEVERAL offices
 * at once ("Menlo Park, CA; New York, NY; Washington, DC" as one
 * listing), and the map should show a pin at every one of them, not just
 * whichever city happened to be listed first. Each resolved location
 * becomes a row in role_locations (see schema.sql); roles.resolved_city/
 * state/latitude/longitude keep only the FIRST one as a summary column
 * (used to mark a role "processed" and by any older code path that
 * doesn't need the full set).
 *
 * Location strings are messy and inconsistent across boards. This handles,
 * in order:
 *   1. "US-XX-City" (e.g. "US-CA-Menlo Park") -- single-location by
 *      construction, so this short-circuits to just that one.
 *   2. "US <Full State Name> (<City>)..." (e.g. "US California (Redwood
 *      City) - Office") -- also single-location, same short-circuit.
 *   3. A left-to-right SEARCH (not a whole-string match) collecting EVERY
 *      plausible "City, ST" or "City, Full State Name" pair anywhere in
 *      the string, not stopping at the first — handles trailing/
 *      interleaved noise of all shapes without needing a rule for each
 *      one: "Washington, DC - Remote", "Burlington, MA | Hybrid",
 *      "San Francisco, CA • New York, NY • United States", "New York,
 *      NY, US" (bare "US"), and multi-office strings with no delimiter
 *      at all ("San Francisco, CA, New York, NY, Portland, OR, or Remote
 *      ..."). Non-US pairs (e.g. "Toronto, ON") are correctly rejected
 *      since ON isn't a US state abbreviation. Duplicate (city, state)
 *      matches within one string are deduped to one location.
 *   4. A short list of major US tech-hub cities given bare, with no state
 *      at all (e.g. "San Francisco", "NYC", "Austin"), checked per
 *      ";"/"•"/"|"-separated segment (so "Austin; NYC" catches both).
 * What's left after all of that (bare "Remote", "United States", country
 * names like "Portugal"/"India") has no specific place to pin from the
 * posting's own text. Rather than drop those roles entirely, a second pass
 * at the end of main() tries, in order: (1) the company's DOMINANT office
 * (wherever it already has the most other real, resolved locations), then
 * (2) a curated headquarters on companies.city/state, for a company with
 * NO resolved office at all (every one of its roles is remote). Either way
 * the resulting role_locations row is marked is_remote = 1 -- so a fully-
 * remote posting still shows up on the map, associated with the company it
 * actually belongs to, instead of silently vanishing. Below the dominant-
 * PM-office tier, before falling back to a manually curated HQ, is a
 * third tier that mines sync.ts's company_board_locations table -- every
 * distinct location string seen across a company's FULL board (every
 * department, not just the PM postings this app stores as roles). A
 * company whose 1-2 PM postings are all "Remote" often still has a real,
 * discoverable office once you look at its engineering/sales/support
 * postings too, and that data is already being fetched during sync at no
 * extra cost -- this tier just stops discarding it. Manually curated HQs
 * (companies.city/state) remain the last resort, for a company with no
 * resolved office anywhere in its own data at all.
 *
 * Geocoding itself uses OpenStreetMap's Nominatim (free, no API key) —
 * rate-limited to 1 request/second per Nominatim's usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/). Many roles
 * resolve to the same city (e.g. dozens of "San Francisco, CA, USA"
 * postings across different companies, or the same city appearing twice
 * within one multi-office role), so this caches results by query string
 * within a run and only sleeps before an actual network call — this is
 * what keeps re-running cheap. Only roles missing geocoded_at are
 * processed, so a re-run only pays for genuinely new locations.
 *
 * Usage: npm run geocode
 */

import { getDb } from "../db/client.js";
import { extractAllCityStates, type ParsedLocation } from "./locationParser.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "tolara-atlas/0.1 (portfolio project; contact: pendletongabriel@gmail.com)";

async function geocodeQuery(query: string): Promise<{ lat: number; lon: number } | null> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return null;
    const results = (await resp.json()) as Array<{ lat: string; lon: string }>;
    if (results.length === 0) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const db = getDb();

  const roles = db
    .prepare(
      `SELECT id, location FROM roles WHERE status = 'active' AND geocoded_at IS NULL`,
    )
    .all() as Array<{ id: number; location: string | null }>;

  // roles.resolved_city/state/latitude/longitude stay populated from the
  // FIRST location found, same as before -- geocoded_at is what marks a
  // role as "processed" so re-runs skip it, and a handful of older/other
  // code paths still read the single-location columns. The full set of
  // locations (one row per office a role is actually open in) lives in
  // role_locations, which is what the export now reads pins from.
  const updateRoleSummary = db.prepare(
    `UPDATE roles SET resolved_city = ?, resolved_state = ?, latitude = ?, longitude = ?, geocoded_at = datetime('now') WHERE id = ?`,
  );
  const markAttempted = db.prepare(`UPDATE roles SET geocoded_at = datetime('now') WHERE id = ?`);
  const clearLocations = db.prepare(`DELETE FROM role_locations WHERE role_id = ?`);
  const insertLocation = db.prepare(
    `INSERT INTO role_locations (role_id, raw_segment, resolved_city, resolved_state, latitude, longitude, geocoded_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  // query string -> result (or null for "resolved to nothing"), so repeat
  // cities across many roles (and repeat cities WITHIN one multi-office
  // role) cost one network call instead of one each. Declared here, before
  // the "nothing new to geocode" check below, because the remote/HQ
  // fallback pass further down reuses this same cache -- that pass must
  // run every time regardless of whether this main loop had any new roles
  // to process (a role can still be MISSING its role_locations rows -- via
  // a manual data fix, say -- even when every role's OWN geocoded_at is
  // already set).
  const cache = new Map<string, { lat: number; lon: number } | null>();

  let geocoded = 0;
  let skipped = 0;
  let cacheHits = 0;
  let extraLocations = 0;

  if (roles.length === 0) {
    console.log("Nothing new to geocode from roles' own location text — every active role already has geocoded_at set.");
  } else {
    console.log(`Geocoding ${roles.length} active roles (1 req/sec per new location, cached by query)...`);
  }

  for (const role of roles) {
    const parsedList = extractAllCityStates(role.location ?? "");
    if (parsedList.length === 0) {
      markAttempted.run(role.id);
      skipped += 1;
      continue;
    }

    clearLocations.run(role.id);

    let firstResolved: { parsed: ParsedLocation; result: { lat: number; lon: number } } | null = null;

    for (const parsed of parsedList) {
      let result: { lat: number; lon: number } | null;
      if (cache.has(parsed.query)) {
        result = cache.get(parsed.query)!;
        cacheHits += 1;
      } else {
        result = await geocodeQuery(parsed.query);
        cache.set(parsed.query, result);
        await sleep(1100);
      }

      if (result) {
        insertLocation.run(role.id, parsed.query, parsed.city, parsed.state, result.lat, result.lon);
        if (!firstResolved) firstResolved = { parsed, result };
        else extraLocations += 1;
      }
    }

    if (firstResolved) {
      const { parsed, result } = firstResolved;
      updateRoleSummary.run(parsed.city, parsed.state, result.lat, result.lon, role.id);
      geocoded += 1;
    } else {
      markAttempted.run(role.id);
      skipped += 1;
    }
  }

  // --- Remote-only postings: pinned at the company's dominant office ---
  // A role whose location string had no resolvable city at all (e.g.
  // "Remote - USA", "Remote") got zero role_locations rows above and, left
  // alone, would just vanish from the map -- there's no city to put a pin
  // at. Rather than drop it, pin it at wherever that company already has
  // the most OTHER real offices (its "dominant" location), so a fully-
  // remote posting still shows up somewhere findable instead of silently
  // disappearing. Runs over every active role still missing role_locations
  // rows, not just this run's newly-processed ones, so a role that fell
  // into this bucket before this fallback existed gets picked up too. Once
  // a role gets a remote-assigned row it's excluded from this query on
  // later runs (it's no longer "missing"), so the assignment is stable
  // rather than drifting every time the company's office mix shifts.
  const unplaced = db
    .prepare(
      `SELECT roles.id, roles.company_id, roles.location
       FROM roles
       LEFT JOIN role_locations ON role_locations.role_id = roles.id
       WHERE roles.status = 'active' AND role_locations.id IS NULL`,
    )
    .all() as Array<{ id: number; company_id: number; location: string | null }>;

  const dominantForCompany = db.prepare(
    `SELECT role_locations.resolved_city, role_locations.resolved_state,
            role_locations.latitude, role_locations.longitude, COUNT(*) AS n
     FROM role_locations
     JOIN roles ON roles.id = role_locations.role_id
     WHERE roles.company_id = ? AND role_locations.is_remote = 0
     GROUP BY role_locations.resolved_city, role_locations.resolved_state
     ORDER BY n DESC
     LIMIT 1`,
  );
  // Second-tier fallback, below the dominant-OWN-PM-office lookup: mine
  // sync.ts's company_board_locations -- every distinct location string
  // seen across the company's FULL board (all departments), not just its
  // PM postings. A company can easily have zero resolved PM offices (all
  // its PM roles say "Remote") while still having a real, findable office
  // according to its engineering/sales/support postings; this reuses that
  // signal instead of requiring a person to look it up by hand. Weighted
  // by how many postings on the board actually use each raw location
  // string, so a company's true office footprint wins over a stray one-off
  // mention.
  const boardLocationsForCompany = db.prepare(
    `SELECT raw_location, posting_count FROM company_board_locations WHERE company_id = ?`,
  );

  function dominantFromBoardLocations(companyId: number): { city: string; state: string } | null {
    const rows = boardLocationsForCompany.all(companyId) as Array<{
      raw_location: string;
      posting_count: number;
    }>;
    const tally = new Map<string, { city: string; state: string; weight: number }>();
    for (const row of rows) {
      for (const parsed of extractAllCityStates(row.raw_location)) {
        const key = `${parsed.city.toLowerCase()}|${parsed.state}`;
        const existing = tally.get(key);
        if (existing) existing.weight += row.posting_count;
        else tally.set(key, { city: parsed.city, state: parsed.state, weight: row.posting_count });
      }
    }
    let best: { city: string; state: string; weight: number } | null = null;
    for (const candidate of tally.values()) {
      if (!best || candidate.weight > best.weight) best = candidate;
    }
    return best ? { city: best.city, state: best.state } : null;
  }

  // Last-resort fallback: a manually-curated headquarters on the companies
  // row itself (companies.city/state), for a company with no resolved
  // office anywhere in its own data -- every one of its roles is remote
  // AND its full board has nothing resolvable either (or it has no board
  // data at all, e.g. before its next sync run). companies.city/state/
  // latitude/longitude aren't populated by the sync pipeline; they're
  // filled in by hand for companies worth the one-time lookup.
  // latitude/longitude are geocoded here on first use if city/state are
  // set but coordinates aren't yet.
  const companyHqRow = db.prepare(`SELECT city, state, latitude, longitude FROM companies WHERE id = ?`);
  const saveCompanyHqCoords = db.prepare(
    `UPDATE companies SET latitude = ?, longitude = ?, geocoded_at = datetime('now') WHERE id = ?`,
  );
  const insertRemoteLocation = db.prepare(
    `INSERT INTO role_locations (role_id, raw_segment, resolved_city, resolved_state, latitude, longitude, is_remote, geocoded_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
  );

  let remoteAssigned = 0;
  let boardAssigned = 0;
  let hqAssigned = 0;
  let remoteUnplaceable = 0;
  // company_id -> its dominant office, or null if it has none (every one
  // of its OTHER roles is also unplaced) -- cached so a company with many
  // remote postings only costs one lookup query, not one per role.
  const dominantCache = new Map<number, { city: string; state: string; lat: number; lon: number } | null>();
  // company_id -> its dominant office computed from the full board (all
  // departments), or null if that yielded nothing either -- same caching
  // reasoning as dominantCache.
  const boardCache = new Map<number, { city: string; state: string } | null>();
  // company_id -> its curated HQ (from companies.city/state), or null if
  // it has none set -- same caching reasoning as dominantCache.
  const hqCache = new Map<number, { city: string; state: string; lat: number; lon: number } | null>();

  for (const role of unplaced) {
    let dominant = dominantCache.get(role.company_id);
    if (dominant === undefined) {
      const row = dominantForCompany.get(role.company_id) as
        | { resolved_city: string; resolved_state: string; latitude: number; longitude: number }
        | undefined;
      dominant = row
        ? { city: row.resolved_city, state: row.resolved_state, lat: row.latitude, lon: row.longitude }
        : null;
      dominantCache.set(role.company_id, dominant);
    }

    if (dominant) {
      insertRemoteLocation.run(role.id, role.location, dominant.city, dominant.state, dominant.lat, dominant.lon);
      updateRoleSummary.run(dominant.city, dominant.state, dominant.lat, dominant.lon, role.id);
      remoteAssigned += 1;
      continue;
    }

    let boardDominant = boardCache.get(role.company_id);
    if (boardDominant === undefined) {
      boardDominant = dominantFromBoardLocations(role.company_id);
      boardCache.set(role.company_id, boardDominant);
    }

    if (boardDominant) {
      const query = `${boardDominant.city}, ${boardDominant.state}, USA`;
      let result = cache.has(query) ? cache.get(query)! : null;
      if (!cache.has(query)) {
        result = await geocodeQuery(query);
        cache.set(query, result);
        await sleep(1100);
      }
      if (result) {
        insertRemoteLocation.run(role.id, role.location, boardDominant.city, boardDominant.state, result.lat, result.lon);
        updateRoleSummary.run(boardDominant.city, boardDominant.state, result.lat, result.lon, role.id);
        boardAssigned += 1;
        continue;
      }
    }

    let hq = hqCache.get(role.company_id);
    if (hq === undefined) {
      const row = companyHqRow.get(role.company_id) as
        | { city: string | null; state: string | null; latitude: number | null; longitude: number | null }
        | undefined;
      if (row?.city && row?.state) {
        let lat = row.latitude;
        let lon = row.longitude;
        if (lat == null || lon == null) {
          const query = `${row.city}, ${row.state}, USA`;
          let result = cache.has(query) ? cache.get(query)! : null;
          if (!cache.has(query)) {
            result = await geocodeQuery(query);
            cache.set(query, result);
            await sleep(1100);
          }
          if (result) {
            lat = result.lat;
            lon = result.lon;
            saveCompanyHqCoords.run(lat, lon, role.company_id);
          }
        }
        hq = lat != null && lon != null ? { city: row.city, state: row.state, lat, lon } : null;
      } else {
        hq = null;
      }
      hqCache.set(role.company_id, hq);
    }

    if (!hq) {
      // No dominant office AND no curated headquarters -- nowhere
      // reasonable to pin this one, so it's left off the map.
      remoteUnplaceable += 1;
      continue;
    }

    insertRemoteLocation.run(role.id, role.location, hq.city, hq.state, hq.lat, hq.lon);
    updateRoleSummary.run(hq.city, hq.state, hq.lat, hq.lon, role.id);
    hqAssigned += 1;
  }

  console.log(
    `\nGeocoding complete: ${geocoded} roles resolved, ${skipped} skipped/failed, ${cacheHits} served from cache ` +
      `(${cache.size} unique locations looked up), ${extraLocations} additional office locations found for multi-office postings.`,
  );
  console.log(
    `Remote postings: ${remoteAssigned} pinned at their company's dominant PM office, ${boardAssigned} pinned at ` +
      `a dominant office learned from the company's full board, ${hqAssigned} pinned at a curated headquarters, ` +
      `${remoteUnplaceable} left off the map (no resolved office, board office, or curated HQ for that company).`,
  );
}

main().catch((err) => {
  console.error("Geocoding failed:", err);
  process.exitCode = 1;
});
