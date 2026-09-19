/**
 * filters/productManager.ts
 * Classifies a job title as a Product Manager role or not. Ported from
 * Maester's role_profiles/product_manager.py (title_include / title_exclude
 * lists), plus one fix on top of that original logic.
 *
 * The original substring-based include/exclude check has a real failure
 * mode: short, generic exclude terms like "developer" or "architect" match
 * as plain substrings anywhere in the (whitespace-stripped) title, not just
 * when they describe the person's own job function. That wrongly drops
 * titles like "Product Manager, Developer Platform" (excluded via
 * "developer") or "Senior Product Manager, App Performance & Architecture"
 * (excluded via "architect" matching inside "architecture") — both are
 * unambiguously PM roles; the flagged word is just naming the team or
 * scope, not the person's function.
 *
 * Fix: if a title contains one of a small set of unambiguous PM phrases
 * literally (case-insensitive substring on the raw title, not the
 * whitespace-stripped normalized form), it's classified as PM regardless
 * of what else the title says. The exclude list still applies to the
 * looser, shorter include terms below, where a false positive is a real
 * risk (e.g. "cpo" or "product lead" appearing inside an unrelated title).
 */

import { normalizeTitle } from "../sources/common.js";

export const PM_TITLE_INCLUDE: string[] = [
  "product manager",
  "product owner",
  "product lead",
  "group product manager",
  "technical product manager",
  "product management",
  "product strategist",
  "outcomes manager",
  "product director",
  "chief product officer",
  "product builder",
];

// "cpo" can't be an ordinary include term: matched as a substring of the
// whitespace-stripped title it fired inside "publi[c po]licy", "paramedi[c
// po]sitions", "CN[C Po]lishing", "Electri[c Po]wertrain" -- 36 active
// non-PM roles on the map at the time -- and even as a whole word it means
// co-packaged optics ("Senior CPO System Hardware Engineer") or names an
// org ("Customer Advocate, Office of the CPO"). So it only counts when it
// LEADS the title: "CPO", "CPO - Acme", "Interim CPO". "Chief Product
// Officer" is matched separately via STRONG_PM_PHRASES.
const LEADING_CPO = /^(?:interim |fractional )?cpo\b/i;

// Product LEADERSHIP titles. Replaces the fixed phrases "head of product",
// "director of product", "vp of product" and "vp, product", which were
// wrong both ways: they missed "VP Product", "Vice President of Product",
// "SVP Product", "Director, Product", "Senior Director, Product",
// "Head, Product"; and as prefixes they counted "Head of Product
// Marketing", "VP, Product Marketing", "Head of Product Design", "Director
// of Product Engineering", "Head of Product Operations".
//
// Matches optional seniority words, then a leadership title, then
// "product(s)" -- anchored at the START of the title so "Sales Director,
// Product Solutions" or "Design Director, Product" don't count -- and then
// checks the qualifier after "product" (up to the next comma, paren, or
// dash): if it names a different function anywhere in it, it's not a PM
// role. Checking only the next word let through "Senior Director, Product
// & Technology Finance", "Director, Product Learning & Development" and
// "Director, Product Sourcing Engineering". "Director, Product
// Management" and "Director, Product Growth" are fine. One carve-out:
// combined product leadership ("Head of Product & Design", "VP, Product
// and Engineering") still counts.
const SENIORITY = String.raw`(?:(?:senior|sr\.?|group|global|associate|assoc\.?|interim|acting|deputy|founding|executive)\s+)*`;
const LEADER = String.raw`(?:vp|vice\s+president|svp|evp|avp|head|director|chief)`;
const NON_PM_FUNCTION = [
  "marketing",
  "design",
  "designer",
  "engineering",
  "engineer",
  "operations",
  "ops",
  "security",
  "sales",
  "analytics",
  "data",
  "support",
  "counsel",
  "legal",
  "finance",
  "quality",
  "safety",
  "compliance",
  "policy",
  "communications",
  "comms",
  "partnerships?",
  "development",
  "research",
  "science",
  "documentation",
  "content",
  "enablement",
  "training",
  "supply",
  "merchandising",
  "creative",
  "production",
  "finance",
  "accounting",
  "sourcing",
  "procurement",
  "learning",
  "recruiting",
  "talent",
  "people",
].join("|");
const PRODUCT_LEADERSHIP = new RegExp(String.raw`^\s*${SENIORITY}${LEADER}\s*(?:of|,|-|–|—|:)?\s*(?:the\s+)?products?\b(.*)$`, "i");
const NON_PM_QUALIFIER = new RegExp(String.raw`\b(?:${NON_PM_FUNCTION})\b`, "i");
const COMBINED_PRODUCT_LEADERSHIP = /^\s*(?:&|and)\s+(?:design|engineering|technology|ux)\s*$/i;

function isProductLeadership(title: string): boolean {
  const match = title.match(PRODUCT_LEADERSHIP);
  if (!match) return false;
  // The qualifier: whatever follows "product", up to the first comma,
  // paren, pipe, or spaced dash (which usually starts a team/location).
  const qualifier = match[1].split(/,|\(|\||\s[-–—]\s/)[0];
  if (COMBINED_PRODUCT_LEADERSHIP.test(qualifier)) return true;
  return !NON_PM_QUALIFIER.test(qualifier);
}

// "PM" abbreviations: "Staff PM", "Lead PM", "Senior PM, Ads", "PM - Search",
// "GPM". Only with a PM-style seniority word in front or leading the title,
// and never when the title says what else PM stands for there -- "Senior
// PM" is also common shorthand for a construction/operations PROJECT
// manager.
const PM_ABBREVIATION =
  /(?:^\s*(?:pm|gpm)\b(?!\s*[/&]))|\b(?:senior|sr\.?|staff|lead|principal|group|associate|technical|junior|jr\.?)\s+pm\b/i;
const PM_ABBREVIATION_NOT_PRODUCT =
  /\b(?:project|program|programme|construction|property|facilit(?:y|ies)|site|field|superintendent|maintenance|mechanical|electrical|civil|plumbing|hvac|estimat(?:or|ing)|preconstruction|building|capital|shift|evening|night|pm shift)\b|\b\d{1,2}(?::\d{2})?\s*pm\b/i;

// Airbnb titles its PM roles "Platform Manager" ("Staff Platform Manager,
// AI Personalization", "Senior Manager, Platform Management (Payments)").
// Across all ~53k synced postings nobody else used the title except as a
// side phrase ("Field Enablement Manager (Enablement Program and Platform
// Manager)"), so it only counts leading the title, after seniority words.
const PLATFORM_MANAGER =
  /^\s*(?:(?:senior|sr\.?|staff|principal|lead|group|associate)\s+)*platform\s+manager\b|^\s*(?:senior\s+|sr\.?\s+)?(?:manager|director|head),?\s+(?:of\s+)?platform\s+management\b/i;

function isPmAbbreviation(title: string): boolean {
  return PM_ABBREVIATION.test(title) && !PM_ABBREVIATION_NOT_PRODUCT.test(title);
}
// "Product Head" / "Product Head, Payments" (common in India-based postings).
const PRODUCT_HEAD = /^\s*products?\s+head\b/i;

export const PM_TITLE_EXCLUDE: string[] = [
  "software engineer",
  "product engineer",
  "backend engineer",
  "frontend engineer",
  "full-stack",
  "fullstack",
  "full stack",
  "devops",
  "architect",
  "developer",
  "data engineer",
  "ml engineer",
  "machine learning engineer",
  "qa engineer",
  "sre",
  "rails engineer",
  "staff engineer",
  "senior engineer",
];

// Phrases specific enough that a title containing one of them is a PM role
// no matter what else is in the title — there's no realistic job title
// that says "Product Manager" but isn't one.
const STRONG_PM_PHRASES = [
  "product manager",
  "product owner",
  "group product manager",
  "technical product manager",
  "product director",
  "chief product officer",
];

/**
 * Classifies a single job title. This is the shared source of truth for
 * "is this a Product Manager posting" — sync.ts calls it after fetching a
 * board's full, unfiltered postings, rather than baking the filter into
 * the fetch itself. That split means tuning this function changes what the
 * *next* sync stores without needing to touch the ATS adapters at all.
 */
export function matchesProductManagerFilter(title: string): boolean {
  const lower = title.toLowerCase();
  if (STRONG_PM_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  if (LEADING_CPO.test(title.trim())) return true;
  if (isProductLeadership(title) || PRODUCT_HEAD.test(title)) return true;
  if (isPmAbbreviation(title)) return true;
  if (PLATFORM_MANAGER.test(title)) return true;

  const normalized = normalizeTitle(title);
  const includeNormalized = PM_TITLE_INCLUDE.map(normalizeTitle);
  const excludeNormalized = PM_TITLE_EXCLUDE.map(normalizeTitle);
  const included = includeNormalized.some((ok) => normalized.includes(ok));
  const excluded = excludeNormalized.some((bad) => normalized.includes(bad));
  return included && !excluded;
}
