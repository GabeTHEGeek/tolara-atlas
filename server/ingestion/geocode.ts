/**
 * ingestion/geocode.ts
 * Populates companies.latitude/longitude (and city/state) so the map has
 * something to plot. ATS APIs don't give us a company HQ address, so this
 * infers a representative location from the company's own active job
 * postings, using the most frequent parseable location among them.
 *
 * Location strings are messy and inconsistent across boards. This handles,
 * in order:
 *   1. "US-XX-City" (e.g. "US-CA-Menlo Park")
 *   2. "US <Full State Name> (<City>)..." (e.g. "US California (Redwood City) - Office")
 *   3. Prefix/suffix noise: "Hybrid - ", "Remote - ", "... HQ", "... Office"
 *   4. "City, ST" / "City, Full State Name[, Country]", tried per ";"-separated
 *      segment (a posting can list several offices) — non-US segments
 *      (e.g. "Vancouver, British Columbia, Canada") are correctly skipped.
 *   5. A short list of major US tech-hub cities given bare, with no state
 *      at all (e.g. "San Francisco", "NYC", "Austin").
 * What's left after all of that (bare "Remote", "United States", country
 * names like "Portugal"/"India") genuinely has no specific place to pin —
 * those companies are left ungeocoded on purpose rather than guessed at.
 *
 * Geocoding itself uses OpenStreetMap's Nominatim (free, no API key) —
 * rate-limited to 1 request/second per Nominatim's usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/), so this is
 * slow by design. Only companies missing geocoded_at are processed, so
 * re-running is cheap.
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

interface RoleLocation {
  company_id: number;
  location: string;
}

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
  // Leading work-mode qualifiers: "Hybrid - New York City" -> "New York City"
  s = s.replace(/^(?:hybrid|remote|onsite|on-site|in-office|in office)\s*[-:]\s*/i, "");
  // Trailing office/HQ labels: "San Francisco HQ" / "New York City Office" / "... - Office"
  s = s.replace(/\s*[-–]?\s*(?:headquarters|hq|office)\s*$/i, "");
  // Parenthetical qualifiers anywhere: "United States (Remote)" -> "United States"
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

function parseSegment(segment: string): ParsedLocation | null {
  const cleaned = stripNoise(segment);

  const abbrevMatch = cleaned.match(
    /^([A-Za-z][A-Za-z.\s'-]*?),\s*([A-Z]{2})(?:,\s*(?:United States|USA|U\.S\.A?\.?))?$/,
  );
  if (abbrevMatch) {
    const city = abbrevMatch[1].trim();
    const state = abbrevMatch[2].trim();
    if (US_STATE_ABBREVS.has(state) && isPlausibleCity(city)) return toParsed(city, state);
  }

  const fullNameMatch = cleaned.match(
    /^([A-Za-z][A-Za-z.\s'-]*?),\s*([A-Za-z][A-Za-z\s]*?)(?:,\s*(?:United States|USA|U\.S\.A?\.?))?$/,
  );
  if (fullNameMatch) {
    const city = fullNameMatch[1].trim();
    const stateAbbrev = US_STATE_NAMES[fullNameMatch[2].trim().toLowerCase()];
    if (stateAbbrev && isPlausibleCity(city)) return toParsed(city, stateAbbrev);
  }

  // Bare known city, no state in the string at all ("San Francisco", "NYC").
  const known = KNOWN_CITIES[cleaned.toLowerCase()];
  if (known) return toParsed(known.city, known.state);

  return null;
}

function extractCityState(raw: string): ParsedLocation | null {
  if (!raw) return null;

  const dashFormat = parseUsDashFormat(raw);
  if (dashFormat) return dashFormat;

  const stateParenCity = parseUsStateParenCity(raw);
  if (stateParenCity) return stateParenCity;

  const segments = raw.split(";").map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const parsed = parseSegment(segment);
    if (parsed) return parsed;
  }
  return null;
}

async function geocode(query: string): Promise<{ lat: number; lon: number } | null> {
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

  const companies = db
    .prepare(`SELECT id, name FROM companies WHERE geocoded_at IS NULL`)
    .all() as Array<{ id: number; name: string }>;

  if (companies.length === 0) {
    console.log("Nothing to geocode — every company already has geocoded_at set.");
    return;
  }

  console.log(`Geocoding ${companies.length} companies (1 req/sec, so this will take a bit)...`);

  const getRoleLocations = db.prepare(
    `SELECT location FROM roles WHERE company_id = ? AND status = 'active' AND location IS NOT NULL AND location != ''`,
  );
  const updateCompany = db.prepare(
    `UPDATE companies SET city = ?, state = ?, latitude = ?, longitude = ?, geocoded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  );
  const markAttempted = db.prepare(
    `UPDATE companies SET geocoded_at = datetime('now') WHERE id = ?`,
  );

  let geocoded = 0;
  let skipped = 0;

  for (const company of companies) {
    const locations = (getRoleLocations.all(company.id) as RoleLocation[]).map((r) => r.location);

    const counts = new Map<string, { count: number } & ParsedLocation>();
    for (const raw of locations) {
      const parsed = extractCityState(raw);
      if (!parsed) continue;
      const key = `${parsed.city}|${parsed.state}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { count: 1, ...parsed });
    }

    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) {
      console.log(`  skip: ${company.name} (no city/state found in ${locations.length} posting locations)`);
      markAttempted.run(company.id);
      skipped += 1;
      continue;
    }

    const result = await geocode(best.query);
    if (result) {
      updateCompany.run(best.city, best.state, result.lat, result.lon, company.id);
      console.log(`  ok:   ${company.name} -> ${best.city}, ${best.state} (${result.lat}, ${result.lon})`);
      geocoded += 1;
    } else {
      console.log(`  fail: ${company.name} -> "${best.query}" did not resolve`);
      markAttempted.run(company.id);
      skipped += 1;
    }

    await sleep(1100);
  }

  console.log(`\nGeocoding complete: ${geocoded} resolved, ${skipped} skipped/failed.`);
}

main().catch((err) => {
  console.error("Geocoding failed:", err);
  process.exitCode = 1;
});
