/**
 * enrichment/companyWeb.ts
 * Two free, keyless fallbacks for the company snapshot, used when Wikidata
 * has nothing (most startups) or is missing a field:
 *
 *   Clearbit autocomplete -- the company's domain. Near-universal coverage,
 *   no key: https://autocomplete.clearbit.com/v1/companies/suggest
 *   (its companion logo.clearbit.com was retired -- the host no longer
 *   resolves -- so the icon comes from DuckDuckGo's favicon service, also
 *   keyless, which returns a PNG for any domain.)
 *
 *   SEC EDGAR -- headquarters city/state and industry for US public
 *   companies (Datadog, Okta, Snowflake...), straight from their filings.
 *   The SEC rejects requests (403) unless the User-Agent carries a contact
 *   email address -- see SEC_USER_AGENT below.
 *
 * Both follow the same rule as wikidata.ts: a result only counts when its
 * name matches the company's, and undefined (rather than null) is returned
 * when the request itself failed, so a rate limit is never cached as "no
 * such company".
 */

const USER_AGENT = "TolaraAtlas/0.1 (+https://github.com/GabeTHEGeek/tolara-atlas)";
// data.sec.gov's fair-access policy requires a contact address, not a URL:
// https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = "TolaraAtlas/0.1 (info@trytolara.com)";
const TIMEOUT_MS = 10000;
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;

export interface CompanyWeb {
  domain: string;
  logoUrl: string;
}

export interface EdgarCompany {
  name: string;
  city: string | null;
  state: string | null;
  industry: string | null;
  filingsUrl: string;
}

// Same normalization as wikidata.ts so "Meta" matches "Meta Platforms, Inc."
const CORPORATE_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|holdings?|group|international|technologies|technology|platforms?|labs?|software|systems|solutions|industries|networks|ventures)\b\.?/g;

function normalizeName(s: string): string {
  return s.toLowerCase().replace(CORPORATE_SUFFIX, "").replace(/[^a-z0-9]/g, "");
}

async function getJson(url: string, userAgent = USER_AGENT): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": userAgent } });
    if (!resp.ok) return undefined;
    return await resp.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// Two different companies can share a name ("Rillet" is both rillet.tv and
// rillet.com), so prefer the TLDs companies actually use and take none at
// all when the only match looks like something else -- a wrong logo and
// website is worse than a blank card.
const PREFERRED_TLDS = ["com", "io", "ai", "co", "dev", "app", "so", "xyz", "net", "org"];

/** The company's domain and logo, or null when no suggestion matches the name. */
export async function fetchCompanyWeb(name: string): Promise<CompanyWeb | null | undefined> {
  const data = (await getJson(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`)) as
    | Array<{ name?: string; domain?: string }>
    | undefined;
  if (data === undefined) return undefined;
  const want = normalizeName(name);
  const matches = data.filter((c) => c.domain && c.name && normalizeName(c.name) === want);
  const ranked = matches
    .map((c) => ({ domain: c.domain!, rank: PREFERRED_TLDS.indexOf(c.domain!.split(".").pop() ?? "") }))
    .filter((c) => c.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.domain.length - b.domain.length);
  const best = ranked[0];
  return best ? { domain: best.domain, logoUrl: `https://icons.duckduckgo.com/ip3/${best.domain}.ico` } : null;
}

// name -> CIK for every SEC filer, fetched once a day (~1MB).
let tickerCache: { at: number; byName: Map<string, string> } | null = null;

async function tickerIndex(): Promise<Map<string, string> | undefined> {
  if (tickerCache && Date.now() - tickerCache.at < TICKERS_TTL_MS) return tickerCache.byName;
  const data = (await getJson("https://www.sec.gov/files/company_tickers.json", SEC_USER_AGENT)) as
    | Record<string, { cik_str: number; title?: string }>
    | undefined;
  if (data === undefined) return undefined;
  const byName = new Map<string, string>();
  for (const entry of Object.values(data)) {
    if (!entry.title) continue;
    const key = normalizeName(entry.title);
    if (key && !byName.has(key)) byName.set(key, String(entry.cik_str).padStart(10, "0"));
  }
  tickerCache = { at: Date.now(), byName };
  return byName;
}

/** HQ and industry from the company's SEC filings, or null when it isn't a US public filer. */
export async function fetchEdgarCompany(name: string): Promise<EdgarCompany | null | undefined> {
  const index = await tickerIndex();
  if (index === undefined) return undefined;
  const cik = index.get(normalizeName(name));
  if (!cik) return null;

  const data = (await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, SEC_USER_AGENT)) as
    | {
        name?: string;
        sicDescription?: string;
        addresses?: { business?: { city?: string; stateOrCountry?: string } };
      }
    | undefined;
  if (data === undefined) return undefined;
  const business = data.addresses?.business;
  const titleCase = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return {
    name: data.name ?? name,
    // EDGAR writes addresses in caps ("NEW YORK").
    city: business?.city ? titleCase(business.city) : null,
    state: business?.stateOrCountry ?? null,
    industry: data.sicDescription ? titleCase(data.sicDescription.replace(/^SERVICES-/i, "")) : null,
    filingsUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
  };
}
