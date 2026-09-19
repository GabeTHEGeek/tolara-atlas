/**
 * enrichment/wikidata.ts
 * Company snapshot + leadership from Wikidata (free, no key, CC0 data).
 *
 * Matching a free-text company name to the right Wikidata item is the risky
 * part -- "Box", "Notion", "Loop" are all ordinary words. So a candidate only
 * counts when (a) its English label or an alias equals the company name
 * (case-insensitive, ignoring punctuation and suffixes like "Inc" or
 * "International" -- so "Weight Watchers" matches the alias "Weight Watchers
 * International"), and (b) it's company-shaped: directly an instance of one
 * of COMPANY_CLASSES, or an item that states a CEO (P169), employee count
 * (P1128) or industry (P452) -- Duolingo's item is typed as an "online
 * platform" but carries those. Deliberately no subclass walk (wdt:P279*):
 * for common-word names ("Ramp", "Plaid") with many candidates it took
 * 20-50 seconds per lookup.
 *
 * Name and type still aren't enough ("Mercury" the fintech matched Ford's
 * Mercury car brand), so (c) the item has to corroborate itself: its
 * headquarters is a city where the company actually has offices on our map
 * (or its hand-set HQ), or -- for companies headquartered somewhere we
 * don't list, like TikTok -- it states BOTH a CEO and an employee count,
 * which a brand or product entry like Mercury's does not. Up to 3
 * company-shaped candidates are tried in search order. Anything else returns null and the
 * page shows "not available yet" -- a blank snapshot beats someone else's.
 * Well-known companies resolve; most small startups have no item and stay
 * blank, which is expected.
 *
 * Etiquette per https://www.wikidata.org/wiki/Wikidata:Data_access: a
 * descriptive User-Agent with a contact URL, sequential requests, and the
 * caller spaces companies out.
 */

const USER_AGENT = "TolaraAtlas/0.1 (https://github.com/GabeTHEGeek/tolara-atlas)";
// Someone is waiting on a button click, so a slow query gives up rather
// than hang; the page just shows the snapshot as unavailable.
const SPARQL_TIMEOUT_MS = 8000;

const COMPANY_CLASSES = [
  "Q4830453", // business
  "Q783794", // company
  "Q6881511", // enterprise
  "Q891723", // public company
  "Q1589009", // privately held company
  "Q167037", // corporation
  "Q18388277", // technology company
  "Q1058914", // software company
  "Q43229", // organization
  "Q22687", // bank
  "Q2085381", // publisher
  "Q210167", // video game developer
];
const SEARCH_URL = "https://www.wikidata.org/w/api.php";
const SPARQL_URL = "https://query.wikidata.org/sparql";

export interface CompanyProfile {
  wikidataId: string | null;
  wikidataUrl: string | null;
  // Filled from Clearbit when Wikidata has no website/logo (see companyWeb.ts).
  logoUrl: string | null;
  // Where each part came from, for the "via ..." line under the card.
  sources: Array<{ label: string; url: string | null }>;
  description: string | null; // Wikidata's one-line description
  founded: number | null; // year
  headquarters: string | null;
  industries: string[];
  employees: number | null;
  employeesAsOf: number | null; // year of the employee count, when stated
  website: string | null;
  linkedinCompanyUrl: string | null;
}

export interface Leader {
  name: string;
  title: string; // "CEO" -- Wikidata's P169 is specifically chief executive officer
  linkedinUrl: string | null;
  wikidataUrl: string;
}

/**
 * A failed request has to be distinguishable from "no such company":
 * Wikidata's query service rate-limits with HTTP 429 (Retry-After ~120s),
 * and treating that as "not found" cached an empty profile for days.
 * Returns undefined on a transient failure, null on a real empty answer.
 */
async function getJson(url: string, timeoutMs = 20000, attempt = 0): Promise<unknown | null | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json, application/json" },
    });
    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      // Wait what the service asks for, but only briefly -- someone is
      // waiting on a button click; a longer wait is left for next time.
      const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000, 4000);
      if (attempt === 0) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, waitMs));
        return getJson(url, timeoutMs, 1);
      }
      return undefined;
    }
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return undefined; // timeout or network error -- transient, don't cache as "not found"
  } finally {
    clearTimeout(timer);
  }
}

const CORPORATE_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|holdings?|group|international|technologies|technology|platforms?|labs?|software|systems|solutions|industries|networks|ventures)\b\.?/g;

function normalizeName(s: string): string {
  return s.toLowerCase().replace(CORPORATE_SUFFIX, "").replace(/[^a-z0-9]/g, "");
}

async function candidateIds(name: string): Promise<string[] | undefined> {
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({
    action: "wbsearchentities",
    search: name,
    language: "en",
    type: "item",
    limit: "10",
    format: "json",
  }).toString();
  const data = (await getJson(url.toString())) as
    | { search?: Array<{ id: string; label?: string; aliases?: string[]; match?: { text?: string } }> }
    | null
    | undefined;
  if (data === undefined) return undefined;
  const want = normalizeName(name);
  if (!want) return [];
  return (data?.search ?? [])
    .filter((c) => [c.label, c.match?.text, ...(c.aliases ?? [])].some((t) => t && normalizeName(t) === want))
    .map((c) => c.id);
}

type Binding = Record<string, { value: string } | undefined>;

async function sparql(query: string): Promise<Binding[] | undefined> {
  const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`;
  const data = (await getJson(url, SPARQL_TIMEOUT_MS)) as
    | { results?: { bindings?: Binding[] } }
    | null
    | undefined;
  return data === undefined ? undefined : (data?.results?.bindings ?? []);
}

const entityId = (uri: string | undefined) => uri?.split("/").pop() ?? "";
// Wikidata dates come back as "2008-08-01T00:00:00Z" (or "+2008-..." for
// raw values); only the year is shown.
const year = (iso: string | undefined) => {
  const m = iso?.match(/^\+?(\d{4})/);
  return m ? Number(m[1]) : null;
};

/**
 * Profile and CEO for `name`. `kind: "none"` means no candidate is
 * confidently the same company (a blank card); `kind: "error"` means the
 * lookup itself failed (rate limit, timeout) and must NOT be cached as an
 * answer. `null` fields inside a found profile just mean Wikidata doesn't
 * state that fact.
 */
export type WikidataLookup =
  | { kind: "match"; profile: CompanyProfile; leaders: Leader[] }
  | { kind: "none" }
  | { kind: "error" };
const MAX_CANDIDATES_CHECKED = 3;

function normalizeCity(s: string): string {
  return s.toLowerCase().replace(/^(city of|town of)\s+/, "").replace(/[^a-z]/g, "");
}

export async function fetchWikidataCompany(
  name: string,
  officeCities: string[],
): Promise<WikidataLookup> {
  const ids = await candidateIds(name);
  if (ids === undefined) return { kind: "error" };
  if (ids.length === 0) return { kind: "none" };
  const knownCities = new Set(officeCities.map(normalizeCity));
  if (knownCities.size === 0) return { kind: "none" };

  // Which candidates are businesses, in search-rank order.
  const values = ids.map((id) => `wd:${id}`).join(" ");
  const businessRows = await sparql(
    `SELECT DISTINCT ?item WHERE { VALUES ?item { ${values} }
       { ?item wdt:P31 ?cls . VALUES ?cls { ${COMPANY_CLASSES.map((c) => `wd:${c}`).join(" ")} } }
       UNION { ?item wdt:P169 [] } UNION { ?item wdt:P1128 [] } UNION { ?item wdt:P452 [] } }`,
  );
  if (businessRows === undefined) return { kind: "error" };
  const businesses = new Set(businessRows.map((r) => entityId(r.item?.value)));
  let failed = false;
  // Candidates are scored so a company entry wins over a product entry of
  // the same name: Figma has both, and only one of them carries a CEO.
  let best: { profile: CompanyProfile; leaders: Leader[]; score: number } | null = null;
  for (const id of ids.filter((c) => businesses.has(c)).slice(0, MAX_CANDIDATES_CHECKED)) {
    const result = await companyDetails(id);
    if (result === undefined) {
      failed = true;
      continue;
    }
    if (!result) continue;
    const hqMatches = Boolean(result.profile.headquarters && knownCities.has(normalizeCity(result.profile.headquarters)));
    const strongCompanyEvidence = result.leaders.length > 0 && result.profile.employees !== null;
    if (!hqMatches && !strongCompanyEvidence) continue;
    const score =
      (result.leaders.length > 0 ? 4 : 0) +
      (result.profile.employees ? 2 : 0) +
      (result.profile.industries.length > 0 ? 1 : 0) +
      (result.profile.founded ? 1 : 0) +
      (result.profile.description ? 1 : 0);
    if (!best || score > best.score) best = { ...result, score };
  }
  if (best) return { kind: "match", profile: best.profile, leaders: best.leaders };
  return failed ? { kind: "error" } : { kind: "none" };
}

async function companyDetails(
  id: string,
): Promise<{ profile: CompanyProfile; leaders: Leader[] } | null | undefined> {
  const rows = await sparql(`
    SELECT ?desc ?inception ?hqLabel ?industryLabel ?employees ?employeesAt ?website ?linkedin
           ?ceo ?ceoLabel ?ceoLinkedin ?ceoEnd WHERE {
      BIND(wd:${id} AS ?item)
      OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
      OPTIONAL { ?item wdt:P571 ?inception }
      OPTIONAL { ?item wdt:P159 ?hq }
      OPTIONAL { ?item wdt:P452 ?industry }
      OPTIONAL { ?item p:P1128 ?empSt . ?empSt ps:P1128 ?employees . OPTIONAL { ?empSt pq:P585 ?employeesAt } }
      OPTIONAL { ?item wdt:P856 ?website }
      OPTIONAL { ?item wdt:P4264 ?linkedin }
      OPTIONAL { ?item p:P169 ?ceoSt . ?ceoSt ps:P169 ?ceo . OPTIONAL { ?ceoSt pq:P582 ?ceoEnd }
                 OPTIONAL { ?ceo wdt:P6634 ?ceoLinkedin } }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 500`);
  if (rows === undefined) return undefined;
  if (rows.length === 0) return null;

  const first = (key: string) => rows.map((r) => r[key]?.value).find(Boolean);
  const industries = [...new Set(rows.map((r) => r.industryLabel?.value).filter((v): v is string => Boolean(v)))]
    // Unlabeled items come back as their bare Q-id; not useful to show.
    .filter((v) => !/^Q\d+$/.test(v))
    .slice(0, 3);

  // Employee counts are a time series; keep the most recent dated one, or
  // the largest undated one if none carries a date.
  let employees: number | null = null;
  let employeesAsOf: number | null = null;
  for (const r of rows) {
    const n = Number(r.employees?.value);
    if (!Number.isFinite(n) || n <= 0) continue;
    const y = year(r.employeesAt?.value);
    if (employees === null || (y ?? 0) > (employeesAsOf ?? 0) || (y === employeesAsOf && n > employees)) {
      employees = n;
      employeesAsOf = y;
    }
  }

  const linkedinId = first("linkedin");
  const profile: CompanyProfile = {
    wikidataId: id,
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
    logoUrl: null,
    sources: [{ label: "Wikidata", url: `https://www.wikidata.org/wiki/${id}` }],
    description: first("desc") ?? null,
    founded: year(first("inception")),
    headquarters: first("hqLabel") && !/^Q\d+$/.test(first("hqLabel")!) ? first("hqLabel")! : null,
    industries,
    employees,
    employeesAsOf,
    website: first("website") ?? null,
    linkedinCompanyUrl: linkedinId ? `https://www.linkedin.com/company/${linkedinId}` : null,
  };

  // Current CEOs only: statements with no end date.
  const leaders = new Map<string, Leader>();
  for (const r of rows) {
    const ceoId = entityId(r.ceo?.value);
    const label = r.ceoLabel?.value;
    if (!ceoId || !label || r.ceoEnd || /^Q\d+$/.test(label)) continue;
    const existing = leaders.get(ceoId);
    const linkedin = r.ceoLinkedin?.value ? `https://www.linkedin.com/in/${r.ceoLinkedin.value}` : null;
    leaders.set(ceoId, {
      name: label,
      title: "CEO",
      linkedinUrl: existing?.linkedinUrl ?? linkedin,
      wikidataUrl: `https://www.wikidata.org/wiki/${ceoId}`,
    });
  }

  return { profile, leaders: [...leaders.values()].slice(0, 2) };
}
