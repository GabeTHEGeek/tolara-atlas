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
  "head of product",
  "director of product",
  "vp of product",
  "vp, product",
  "group product manager",
  "technical product manager",
  "product management",
  "product strategist",
  "outcomes manager",
  "product director",
  "chief product officer",
  "cpo",
  "product builder",
];

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
  "head of product",
  "director of product",
  "vp of product",
  "vp, product",
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

  const normalized = normalizeTitle(title);
  const includeNormalized = PM_TITLE_INCLUDE.map(normalizeTitle);
  const excludeNormalized = PM_TITLE_EXCLUDE.map(normalizeTitle);
  const included = includeNormalized.some((ok) => normalized.includes(ok));
  const excluded = excludeNormalized.some((bad) => normalized.includes(bad));
  return included && !excluded;
}
