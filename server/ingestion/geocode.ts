/**
 * ingestion/geocode.ts
 * Resolves each ACTIVE ROLE's own location string to a city/state and
 * lat/lng — not the company's. A company can have PM roles open in more
 * than one office at once, and the map should show a pin at each one
 * rather than guessing a single "representative" location for the whole
 * company (that guess also used to be skewed by small sample size: with
 * only a couple of PM postings, whichever city happened to have more of
 * them got mislabeled as if it meant something about the company overall).
 *
 * Location strings are messy and inconsistent across boards. This handles,
 * in order:
 *   1. "US-XX-City" (e.g. "US-CA-Menlo Park")
 *   2. "US <Full State Name> (<City>)..." (e.g. "US California (Redwood City) - Office")
 *   3. A left-to-right SEARCH (not a whole-string match) for the first
 *      plausible "City, ST" or "City, Full State Name" pair anywhere in
 *      the string — handles trailing/interleaved noise of all shapes
 *      without needing a rule for each one: "Washington, DC - Remote",
 *      "Burlington, MA | Hybrid", "San Francisco, CA • New York, NY •
 *      United States", "New York, NY, US" (bare "US"), and multi-office
 *      strings with no delimiter at all ("San Francisco, CA, New York,
 *      NY, Portland, OR, or Remote ..."). Non-US pairs (e.g. "Toronto,
 *      ON") are correctly rejected since ON isn't a US state abbreviation.
 *   4. A short list of major US tech-hub cities given bare, with no state
 *      at all (e.g. "San Francisco", "NYC", "Austin"), tried per
 *      ";"/"•"/"|"-separated segment.
 * What's left after all of that (bare "Remote", "United States", country
 * names like "Portugal"/"India") genuinely has no specific place to pin —
 * those roles are left ungeocoded on purpose rather than guessed at.
 *
 * Geocoding itself uses OpenStreetMap's Nominatim (free, no API key) —
 * rate-limited to 1 request/second per Nominatim's usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/). Many roles
 * resolve to the same city (e.g. dozens of "San Francisco, CA, USA"
 * postings across different companies), so this caches results by query
 * string within a run and only sleeps before an actual network call —
 * this is what keeps re-running cheap even though it's now per-role
 * rather than per-company. Only roles missing geocoded_at are processed,
 * so a re-run only pays for genuinely new locations.
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
 * Searches (not anchors) for the first plausible "City, ST" or
 * "City, Full State Name" pair anywhere in the text, left to right. This
 * is deliberately a search rather than a whole-string match: real
 * location strings put a valid office ahead of all kinds of trailing or
 * interleaved noise a fixed set of separator rules can't keep up with —
 * "Washington, DC - Remote", "Burlington, MA | Hybrid",
 * "San Francisco, CA • New York, NY • United States", "New York, NY, US"
 * (bare "US", not "United States"), and even multiple offices joined by
 * plain commas with no delimiter at all ("San Francisco, CA, New York,
 * NY, Portland, OR, or Remote ..."). A search naturally finds the first
 * valid pair and ignores everything around it; an implausible match
 * (e.g. "Remote, CA") is skipped in favor of the next candidate rather
 * than failing the whole string.
 */
function findCityState(text: string): ParsedLocation | null {
  const abbrevPattern = /([A-Za-z][A-Za-z.'-]*(?:\s[A-Za-z.'-]+)*),\s*([A-Z]{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = abbrevPattern.exec(text))) {
    const city = m[1].trim();
    const state = m[2].trim();
    if (US_STATE_ABBREVS.has(state) && isPlausibleCity(city)) return toParsed(city, state);
  }

  const fullNamePattern = /([A-Za-z][A-Za-z.'-]*(?:\s[A-Za-z.'-]+)*),\s*([A-Za-z]+(?:\s[A-Za-z]+)*)/g;
  while ((m = fullNamePattern.exec(text))) {
    const city = m[1].trim();
    const stateAbbrev = US_STATE_NAMES[m[2].trim().toLowerCase()];
    if (stateAbbrev && isPlausibleCity(city)) return toParsed(city, stateAbbrev);
  }

  return null;
}

/** Bare known city, no state anywhere in the string ("San Francisco", "NYC"). */
function findKnownCity(raw: string): ParsedLocation | null {
  const segments = raw.split(/[;•|]/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments.length ? segments : [raw]) {
    const known = KNOWN_CITIES[stripNoise(segment).toLowerCase()];
    if (known) return toParsed(known.city, known.state);
  }
  return null;
}

function extractCityState(raw: string): ParsedLocation | null {
  if (!raw) return null;

  const dashFormat = parseUsDashFormat(raw);
  if (dashFormat) return dashFormat;

  const stateParenCity = parseUsStateParenCity(raw);
  if (stateParenCity) return stateParenCity;

  const general = findCityState(raw);
  if (general) return general;

  return findKnownCity(raw);
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

  const updateRole = db.prepare(
    `UPDATE roles SET resolved_city = ?, resolved_state = ?, latitude = ?, longitude = ?, geocoded_at = datetime('now') WHERE id = ?`,
  );
  const markAttempted = db.prepare(`UPDATE roles SET geocoded_at = datetime('now') WHERE id = ?`);

  // query string -> result (or null for "resolved to nothing"), so repeat
  // cities across many roles cost one network call instead of one each.
  const cache = new Map<string, { lat: number; lon: number } | null>();

  let geocoded = 0;
  let skipped = 0;
  let cacheHits = 0;

  for (const role of roles) {
    const parsed = extractCityState(role.location ?? "");
    if (!parsed) {
      markAttempted.run(role.id);
      skipped += 1;
      continue;
    }

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
      updateRole.run(parsed.city, parsed.state, result.lat, result.lon, role.id);
      geocoded += 1;
    } else {
      markAttempted.run(role.id);
      skipped += 1;
    }
  }

  console.log(
    `\nGeocoding complete: ${geocoded} roles resolved, ${skipped} skipped/failed, ${cacheHits} served from cache (${cache.size} unique locations looked up).`,
  );
}

main().catch((err) => {
  console.error("Geocoding failed:", err);
  process.exitCode = 1;
});
