/**
 * ingestion/locationParser.ts
 * Turns a messy free-text location string from an ATS posting into every
 * plausible US city/state pair it contains. Extracted out of geocode.ts so
 * the exact same parsing logic can be reused anywhere a raw location
 * string needs resolving -- originally just roles' own location text
 * (geocode.ts's main loop), now also the full, unfiltered set of a
 * company's board postings (geocode.ts's board-wide dominant-office
 * fallback, fed by sync.ts's company_board_locations table). Keeping one
 * copy means a parser fix (a new KNOWN_CITIES entry, a noise-stripping
 * rule) automatically improves both call sites instead of needing to be
 * duplicated and kept in sync by hand.
 *
 * See extractAllCityStates for the handling order; nothing here talks to
 * the network or the database.
 */

export interface ParsedLocation {
  city: string;
  state: string;
  query: string;
}

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
  "san francisco bay area": { city: "San Francisco", state: "CA" },
  "sf bay area": { city: "San Francisco", state: "CA" },
  "bay area": { city: "San Francisco", state: "CA" },
  "culver city": { city: "Culver City", state: "CA" },
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
  sea: { city: "Seattle", state: "WA" },
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

// Explicit non-US signals, checked against the RAW (unstripped) location
// string. A location with no resolvable US city/state pair falls into one
// of two very different buckets: genuinely ambiguous ("Remote", "United
// States", blank) — a real US-based posting geocode.ts's remote/HQ fallback
// SHOULD pin at the company's US office — versus explicitly naming a
// non-US place ("Paris Area, France", "Barcelona Area", "EMEA") — a
// posting for a role that isn't US-based at all, which that same fallback
// was wrongly treating identically, pinning French/Spanish/etc. roles at
// a US office and mislabeling them "remote" on a US jobs map. This list
// lets the fallback tell the two apart and leave the second group off the
// map entirely instead of guessing a US city for them.
//
// Deliberately NOT exhaustive -- covers the countries/regions/hub cities
// most common in ATS postings for companies that also hire in the US.
// Missing a rarer one just means that particular non-US role falls back to
// "ambiguous" and gets pinned at a US office (the old behavior); that's a
// false negative, not a false positive, so it's the safer direction to
// under-cover in.
const NON_US_COUNTRIES = [
  "france", "spain", "germany", "italy", "portugal", "netherlands", "belgium", "switzerland",
  "austria", "poland", "ireland", "sweden", "norway", "denmark", "finland", "iceland",
  "united kingdom", "scotland", "wales", "northern ireland",
  "india", "singapore", "japan", "china", "hong kong", "taiwan", "australia", "new zealand",
  "canada", "mexico", "brazil", "argentina", "chile", "colombia", "peru", "uruguay",
  "south africa", "israel", "united arab emirates", "philippines", "vietnam", "indonesia",
  "malaysia", "thailand", "south korea", "pakistan", "bangladesh", "saudi arabia", "qatar",
  "romania", "ukraine", "czech republic", "czechia", "hungary", "greece", "turkey", "egypt",
  "nigeria", "kenya", "luxembourg", "estonia", "latvia", "lithuania", "croatia", "serbia", "bulgaria",
];
const NON_US_REGIONS = ["emea", "apac", "latam", "uk & ireland", "uk&i", "nordics", "benelux"];
const NON_US_CITIES = [
  "paris", "barcelona", "madrid", "berlin", "munich", "hamburg", "frankfurt", "amsterdam", "rotterdam",
  "dublin", "london", "manchester", "edinburgh", "toronto", "vancouver", "montreal", "ottawa",
  "sydney", "melbourne", "brisbane", "auckland", "wellington", "tokyo", "osaka",
  "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai", "gurgaon", "gurugram",
  "tel aviv", "warsaw", "krakow", "prague", "lisbon", "porto", "milan", "rome", "turin",
  "stockholm", "copenhagen", "oslo", "helsinki", "zurich", "geneva", "basel", "vienna", "brussels",
  "sao paulo", "são paulo", "mexico city", "bogota", "bogotá", "buenos aires", "santiago", "lima",
  "cape town", "johannesburg", "nairobi", "lagos", "dubai", "abu dhabi", "seoul", "shanghai",
  "beijing", "shenzhen", "kuala lumpur", "jakarta", "manila", "bangkok", "ho chi minh",
];
const NON_US_PATTERN = new RegExp(
  `\\b(?:${[...NON_US_COUNTRIES, ...NON_US_REGIONS, ...NON_US_CITIES].join("|")})\\b`,
  "i",
);

/** True when a raw location string explicitly names a non-US place — see NON_US_PATTERN's comment. */
export function isExplicitlyNonUS(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return NON_US_PATTERN.test(raw);
}

function isPlausibleCity(city: string): boolean {
  if (city.length < 2) return false;
  if (/remote|global|anywhere|worldwide|hybrid/i.test(city)) return false;
  // A bare 2-4 letter ALL-CAPS token ("SF", "SEA", "LA", "DC") is a city
  // abbreviation, not a place name as actually written -- real city names
  // in these postings are Title Case. Rejecting it here matters most for
  // a comma-separated list of abbreviations that includes a real state
  // code ("SF, SEA, NY, Remote-US" -- without this, the "City, ST" regex
  // below reads "SEA, NY" as city "SEA", state "NY"). The bare-known-city
  // lookup further down resolves these correctly instead.
  if (/^[A-Z]{2,4}$/.test(city)) return false;
  return true;
}

function toParsed(city: string, state: string): ParsedLocation {
  return { city, state, query: `${city}, ${state}, USA` };
}

/** Strips noise this dataset actually contains, without touching the core place name. */
function stripNoise(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:hybrid|remote|onsite|on-site|in-office|in office)\s*[-:]\s*/i, "");
  s = s.replace(/\s*[-–:|]?\s*(?:headquarters|hq|office|hub|remote|hybrid|onsite|on-site)\s*$/i, "");
  s = s.replace(/\([^)]*\)/g, "").trim();
  return s.trim();
}

/**
 * Strips country/HQ-label noise tokens that sit right next to the real
 * place name with a separator between them -- "USA - Mountain View, CA",
 * "HQ-San Francisco", "US: San Mateo (...)". Applied to the WHOLE raw
 * string before the city/state search below, because the abbrev/full-name
 * regexes are greedy about what counts as the "city" portion of a "City,
 * ST" match: left in place, "USA - Mountain View, CA" would capture "USA -
 * Mountain View" as the city (garbling the geocoding query) rather than
 * just "Mountain View". Only strips a token immediately followed by a
 * dash/colon/pipe separator, so it never touches a token that's actually
 * part of a real match, like the bare "US" at the end of "New York, NY,
 * US" (nothing follows it to trigger this).
 */
function stripLeadingNoiseTokens(text: string): string {
  return text.replace(/\b(?:USA?|U\.S\.A?\.?|United States|HQ|Hub|Headquarters)\s*[-–:|]\s*/gi, "");
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

/**
 * "US-California-San Jose" -> { city: "San Jose", state: "CA" }
 * Same shape as parseUsDashFormat, but some Workday tenants (confirmed on
 * Cloudera's board) spell the middle segment out as the full state name
 * instead of the two-letter abbreviation. State names never contain a
 * dash themselves, so a non-greedy match up to the NEXT "-" safely finds
 * the state/city boundary even when the city portion has one of its own
 * ("US-North Carolina-Winston-Salem").
 */
function parseUsDashFullStateFormat(raw: string): ParsedLocation | null {
  const match = raw.trim().match(/^US-([A-Za-z][A-Za-z ]+?)-(.+)$/);
  if (!match) return null;
  const state = US_STATE_NAMES[match[1].trim().toLowerCase()];
  const city = match[2].trim();
  if (state && isPlausibleCity(city)) return toParsed(city, state);
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
  // checked per-segment. Two separate splits, because commas mean two
  // different things in this data and mixing them risks a false match:
  //
  // 1. ;/•/| never carry "City, ST" pairing meaning, so a bare 2-letter
  //    match here is unambiguous -- "LA; NYC" safely resolves both.
  // 2. Bare commas/"or" ALSO separate "City, ST" pairs above, so a plain
  //    comma-split can land on a token that's a real state postal code
  //    ("LA" = Louisiana, "DC" = the District) rather than the city
  //    abbreviation of the same letters -- "Baton Rouge, LA" must NOT
  //    also produce a Los Angeles pin. Any exactly-2-letter token that's
  //    a real state abbreviation is skipped in this split only; longer
  //    matches ("NYC", "Chicago") and non-state 2-letter ones ("SF") are
  //    unaffected, so "NYC, Chicago, Seattle, San Francisco" and "San
  //    Francisco Or New York" still resolve every city in the list.
  //
  // Hyphens are normalized to spaces before lookup either way, so
  // "New-York" still matches "New York".
  const lookupKey = (segment: string) =>
    stripNoise(segment).replace(/-/g, " ").replace(/\s+/g, " ").toLowerCase();

  const pipeSegments = text.split(/[;•|]/).map((s) => s.trim()).filter(Boolean);
  for (const segment of pipeSegments.length ? pipeSegments : [text]) {
    const known = KNOWN_CITIES[lookupKey(segment)];
    if (known) add(toParsed(known.city, known.state));
  }

  const commaSegments = text.split(/,|\bor\b/i).map((s) => s.trim()).filter(Boolean);
  for (const segment of commaSegments) {
    if (segment.length === 2 && US_STATE_ABBREVS.has(segment.toUpperCase())) continue;
    const known = KNOWN_CITIES[lookupKey(segment)];
    if (known) add(toParsed(known.city, known.state));
  }

  return results;
}

/**
 * All plausible locations in a raw location string, not just one -- a
 * single posting is frequently open in more than one office at once, and
 * the map should place a pin in each rather than only the first-mentioned
 * city. "US-CA-Menlo Park"-style and "US California (Redwood City)"-style
 * strings are single-location formats by construction, so those short-
 * circuit; everything else goes through the multi-match search.
 */
export function extractAllCityStates(raw: string): ParsedLocation[] {
  if (!raw) return [];

  // "US-CA-Menlo Park" and "US-California-Menlo Park" are both checked
  // against the ORIGINAL string -- they're anchored at the start, so a
  // leading noise token would break the anchor anyway, and both formats
  // are unambiguous as-is.
  const dashFormat = parseUsDashFormat(raw) ?? parseUsDashFullStateFormat(raw);
  if (dashFormat) return [dashFormat];

  const cleaned = stripLeadingNoiseTokens(raw);

  const stateParenCity = parseUsStateParenCity(cleaned);
  if (stateParenCity) return [stateParenCity];

  return findAllCityStates(cleaned);
}
