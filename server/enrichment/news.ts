/**
 * enrichment/news.ts
 * Recent headlines about a company from Google News' public RSS search feed
 * (no key). Only fetched on demand, when someone asks for a company's
 * intelligence on its role page.
 *
 * Company names are often ordinary words ("Box", "Notion", "Ramp"), so the
 * search is an exact-phrase query and each headline must itself contain the
 * name (see mentionsCompany for the stricter rule single-word names get).
 * That drops most false matches at the cost of missing some real stories --
 * the safer direction for a page people use to prepare for interviews.
 */

const USER_AGENT = "TolaraAtlas/0.1 (https://github.com/GabeTHEGeek/tolara-atlas)";
const MAX_ITEMS = 3;
const BUSINESS_TERMS = [
  "startup",
  "CEO",
  "funding",
  "raises",
  "valuation",
  "acquires",
  "acquisition",
  "IPO",
  "earnings",
  "layoffs",
  "launches",
  "product",
  "hiring",
  "revenue",
];

export interface NewsItem {
  title: string;
  source: string | null;
  url: string;
  publishedAt: string | null; // ISO
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

// Words that, right after a single-word name, mark it as the company doing
// something ("Notion Launches...", "Brex Raises...") rather than the plain
// noun ("Box Office", "No Prior Notion").
const COMPANY_VERBS = [
  "launches", "launched", "raises", "raised", "acquires", "acquired", "announces", "announced",
  "unveils", "unveiled", "adds", "hires", "names", "appoints", "cuts", "lays", "files", "reports",
  "posts", "partners", "expands", "releases", "introduces", "rolls", "debuts", "valued", "stock",
  "shares", "ceo", "cfo", "cto", "founder", "inc", "ipo", "earnings", "is", "to", "will", "says",
  "acquisition", "deal", "funding", "valuation", "layoffs", "revenue", "app", "users", "customers",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsCompany(headline: string, name: string, ceoNames: string[]): boolean {
  const escaped = escapeRegex(name);
  const multiWord = /\s/.test(name.trim());
  if (multiWord) {
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(headline);
  }
  // Single-word names are usually also ordinary words, and headlines are
  // Title Case, so a plain match can't tell "Box" the company from "Box
  // Office". Accept only a company-like use: possessive or followed by a
  // company verb, and not glued to a preceding capitalized word ("Global
  // Laser Box raises..." is a different company). Naming the company's CEO
  // is enough on its own.
  if (ceoNames.some((ceo) => headline.includes(ceo))) return true;
  const notPartOfLongerName = String.raw`(?<![A-Z][\w'’.-]*\s)`;
  const possessive = new RegExp(`${notPartOfLongerName}\\b${escaped}['’]s\\b`);
  const verb = new RegExp(`${notPartOfLongerName}\\b${escaped}(?:\\s+[-–—:]?\\s*|\\s+)(?:\\d{4}\\s+)?(?:${COMPANY_VERBS.join("|")})\\b`, "i");
  const caseExact = new RegExp(`\\b${escaped}\\b`);
  return caseExact.test(headline) && (possessive.test(headline) || verb.test(headline));
}

/** Up to 3 recent headlines (last 30 days) that name the company; [] when none or on failure. */
export async function fetchCompanyNews(name: string, ceoNames: string[] = []): Promise<NewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  // Exact phrase AND at least one business-news word. Without the second
  // half, "Box" returned box-office stories, "Notion" returned "the notion
  // of...", and "Capital One" returned Capital One Arena events -- headlines
  // are Title Case, so a case-sensitive match alone can't tell them apart.
  const q = `"${name}" (${BUSINESS_TERMS.join(" OR ")}) when:30d`;
  url.search = new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let xml: string;
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return [];
    xml = await resp.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const raw = tag(m[1], "title");
    const link = tag(m[1], "link");
    if (!raw || !link) continue;
    const source = tag(m[1], "source");
    // Google appends " - Source Name" to every title; the source is shown separately.
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -(source.length + 3)) : raw;
    if (!mentionsCompany(title, name, ceoNames)) continue;
    const pub = tag(m[1], "pubDate");
    const ms = pub ? Date.parse(pub) : NaN;
    items.push({ title, source, url: link, publishedAt: Number.isNaN(ms) ? null : new Date(ms).toISOString() });
  }
  items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return items.slice(0, MAX_ITEMS);
}
