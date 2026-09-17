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
 * names like "Portugal"/"India") genuinely has no specific place to pin —
 * those roles are left ungeocoded on purpose rather than guessed at.
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

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "tolara-atlas/0.1 (portfolio project; contact: pendletongabriel@gmail.com)";

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};
const US_STATE_ABBREVS = new Set(Object.values(US_STATE_NAMES));

// Major US tech-hub cities given bare, with no state at all in the
// original string ("San Francisco", "NYC"). Deliberately conservative —
// only well-known unambiguous hubs, not every US city, to avoid mismatches
// like a small-town "Toronto, Ohio" for the Canadian city of the same name.
const KNOWN_CITIES: Record<string, { city: string; state: string }> = {
  "san francisco": { city: "San Francisco", state: "CA" },
  sf: { city: "San Francisco", state: "CA" },
  "new york city": { city: "New York City", state: "NY" },
  "new york": { city: "New York", state: "NY" },
  nyc: { city: "New York City", state: "NY" },
  "palo alto": { city: "Palo Alto", state: "CA" },
  "san mateo": { city: "San Mateo", state: "CA" },
  "menlo park": { city: "Menlo Park", state: "CA" },
  "redwood city": { city: "Redwood City", state: "CA" },
  "mountain view": { city: "Mountain View", state: "CA" },
  sunnyvale: { city: "Sunnyvale", state: "CA" },
  cupertino: { city: "Cupertino", state: "CA" },
  "santa clara": { city: "Santa Clara", state: "CA" },
  "san jose": { city: "San Jose", state: "CA" },
  oakland: { city: "Oakland", state: "CA" },
  berkeley: { city: "Berkeley", state: "CA" },
  seattle: { city: "Seattle", state: "WA" },
  bellevue: { city: "Bellevue", state: "WA" },
  austin: { city: "Austin", state: "TX" },
  dallas: { city: "Dallas", state: "TX" },
  houston: { city: "Houston", state: "TX" },
  boston: { city: "Boston", state: "MA" },
  cambridge: { city: "Cambridge", state: "MA" },
  chicago: { city: "Chicago", state: "IL" },
  atlanta: { city: "Atlanta", state: "GA" },
  denver: { city: "Denver", state: "CO" },
  boulder: { city: "Boulder", state: "CO" },
  "los angeles": { city: "Los Angeles", state: "CA" },
  la: { city: "Los Angeles", state: "CA" },
  "san diego": { city: "San Diego", state: "CA" },
  irvine: { city: "Irvine", state: "CA" },
  "washington dc": { city: "Washington", state: "DC" },
  dc: { city: "Washington", state: "DC" },
  miami: { city: "Miami", state: "FL" },
  portland: { city: "Portland", state: "OR" },
  "salt lake city": { city: "Salt Lake City", state: "UT" },
  phoenix: { city: "Phoenix", state: "AZ" },
  minneapolis: { city: "Minneapolis", state: "MN" },
  philadelphia: { city: "Philadelphia", state: "PA" },
  detroit: { city: "Detroit", state: "MI" },
  nashville: { city: "Nashville", state: "TN" },
  charlotte: { city: "Charlotte", state: "NC" },
  raleigh: { city: "Raleigh", state: "NC" },
  durham: { city: "Durham", state: "NC" },
  columbus: { city: "Columbus", state: "OH" },
  pittsburgh: { city: "Pittsburgh", state: "PA" },
};

interface ParsedLocation {
  city: string;
  state: string;
  query: string;
}

function isPlausibleCity(city: string): boolean {
  if (city.length < 2) return false;
  return !/remote|global|anywhere|worldwide|hybrid/i.test(city);
}

function toParsed(city: string, state: string): ParsedLocation {
  return { city, state, query: `${city}, ${state}, USA` };
}

/** Strips noise this dataset actually contains, without touching the core place name. */
function stripNoise(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:hybrid|remote|onsite|on-site|in-office|in office)\s*[-:]\s*/i, "");
  s = s.replace(/\s*[-–]?\s*(?:headquarters|hq|office)\s*$/i, "");
  s = s.replace(/\([^)]*\)/g, "").trim();
  return s.trim();
}

/** "US-CA-Menlo Park" -> { city: "Menlo Park", state: "CA" } */
function parseUsDashFormat(raw: string): ParsedLocation | null {
  const match = raw.trim().match(/^US-([A-Z]{2})-(.+)$/);
  if (!match) return null;
  const state = match[1];
  const city = match[2].trim();
  if (US_STATE_ABBREVS.has(state) && isPlausibleCity(city)) return toParsed(city, state);
  return null;
}

/** "US California (Redwood City) - Office" -> { city: "Redwood City", state: "CA" } */
function parseUsStateParenCity(raw: string): ParsedLocation | null {
  const match = raw.trim().match(/^US\s+([A-Za-z\s]+?)\s*\(([^)]+)\)/i);
  if (!match) return null;
  const stateAbbrev = US_STATE_NAMES[match[1].trim().toLowerCase()];
  const city = match[2].trim();
  if (stateAbbrev && isPlausibleCity(city)) return toParsed(city, stateAbbrev);
  return null;
}

/**
 * Searches (not anchors) for EVERY plausible "City, ST" or "City, Full
 * State Name" pair anywhere in the text, left to right -- not just the
 * first. This is deliberately a search rather than a whole-string match:
 * real location strings put valid offices amid all kinds of trailing or
 * interleaved noise a fixed set of separator rules can't keep up with —
 * "Washington, DC - Remote", "Burlington, MA | Hybrid",
 * "San Francisco, CA • New York, NY • United States", "New York, NY, US"
 * (bare "US", not "United States"), and multiple offices joined by plain
 * commas with no delimiter at all ("San Francisco, CA, New York, NY,
 * Portland, OR, or Remote ..."). A search naturally finds every valid
 * pair and ignores everything around it; an implausible match (e.g.
 * "Remote, CA") is skipped in favor of the next candidate rather than
 * failing the whole string. Dedupes by (city, state) so "New York, NY,
 * New York, NY" style repeats in noisy strings don't produce duplicate
 * locations for one role.
 */
function findAllCityStates(text: string): ParsedLocation[] {
  const results: ParsedLocation[] = [];
  const seen = new Set<string>();
  const add = (p: ParsedLocation) => {
    const key = `${p.city.toLowerCase()}|${p.state}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(p);
    }
  };

  const abbrevPattern = /([A-Za-z][A-Za-z.'-]*(?:\s[A-Za-z.'-]+)*),\s*([A-Z]{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = abbrevPattern.exec(text))) {
    const city = m[1].trim();
    const state = m[2].trim();
    if (US_STATE_ABBREVS.has(state) && isPlausibleCity(city)) add(toParsed(city, state));
  }

  const fullNamePattern = /([A-Za-z][A-Za-z.'-]*(?:\s[A-Za-z.'-]+)*),\s*([A-Za-z]+(?:\s[A-Za-z]+)*)/g;
  while ((m = fullNamePattern.exec(text))) {
    const city = m[1].trim();
    const stateAbbrev = US_STATE_NAMES[m[2].trim().toLowerCase()];
    if (stateAbbrev && isPlausibleCity(city)) add(toParsed(city, stateAbbrev));
  }

  // Bare known cities with no state at all ("San Francisco", "NYC"),
  // checked per ;/•/|-separated segment so e.g. "Austin; NYC" catches both.
  const segments = text.split(/[;•|]/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments.length ? segments : [text]) {
    const known = KNOWN_CITIES[stripNoise(segment).toLowerCase()];
    if (known) add(toParsed(known.city, known.state));
  }

  return results;
}

/**
 * All plausible locations in a role's raw location string, not just one --
 * a single posting is frequently open in more than one office at once, and
 * the map should place a pin in each rather than only the first-mentioned
 * city. "US-CA-Menlo Park"-style and "US California (Redwood City)"-style
 * strings are single-location formats by construction, so those short-
 * circuit; everything else goes through the multi-match search.
 */
function extractAllCityStates(raw: string): ParsedLocation[] {
  if (!raw) return [];

  const dashFormat = parseUsDashFormat(raw);
  if (dashFormat) return [dashFormat];

  const stateParenCity = parseUsStateParenCity(raw);
  if (stateParenCity) return [stateParenCity];

  return findAllCityStates(raw);
}

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

  if (roles.length === 0) {
    console.log("Nothing to geocode — every active role already has geocoded_at set.");
    return;
  }

  console.log(`Geocoding ${roles.length} active roles (1 req/sec per new location, cached by query)...`);

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
  // role) cost one network call instead of one each.
  const cache = new Map<string, { lat: number; lon: number } | null>();

  let geocoded = 0;
  let skipped = 0;
  let cacheHits = 0;
  let extraLocations = 0;

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

  console.log(
    `\nGeocoding complete: ${geocoded} roles resolved, ${skipped} skipped/failed, ${cacheHits} served from cache ` +
      `(${cache.size} unique locations looked up), ${extraLocations} additional office locations found for multi-office postings.`,
  );
}

main().catch((err) => {
  console.error("Geocoding failed:", err);
  process.exitCode = 1;
});
