/**
 * filters/productManager.ts
 * Include/exclude normalized-title filter for Product Manager roles. Ported
 * from Maester's role_profiles/product_manager.py (title_include /
 * title_exclude lists only — the rubric/panel/tailor content in that file
 * is specific to Maester's interview-panel feature and not relevant here).
 *
 * Used as `requireTitleKeywords` / `excludeTitles` passed into each ATS
 * adapter's search function.
 */

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
