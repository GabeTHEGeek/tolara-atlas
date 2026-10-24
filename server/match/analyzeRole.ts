/**
 * match/analyzeRole.ts
 * What a role asks for, read once from its posting and cached for every
 * candidate: its PM archetype, years asked, hard requirements, product
 * domain, company stage, and whether it's really an engineering job with a
 * PM title.
 *
 * None of this depends on who's applying, so it's computed once per role
 * and reused across every resume -- the only model work that touches more
 * than a shortlist. Cached in data/role-analysis.json keyed by role id and
 * invalidated by the role's content_hash, so an edited posting is re-read.
 * It lives outside tolara.db on purpose: the nightly job commits the
 * database, and a binary file can't be merged with a local run.
 *
 * Runs on demand (scripts/match-resume.ts), never in the nightly sync --
 * the sync stays free of paid services.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ARCHETYPES, ARCHETYPE_IDS, isArchetype, type Archetype } from "./archetypes.js";
import { jsonCall } from "./llm.js";
import { decodeEntities, stripHtml } from "../ingestion/sources/common.js";

export type CompanyStage = "established" | "growth" | "seed" | "unknown";

export interface RoleAnalysis {
  contentHash: string;
  archetypes: Archetype[]; // primary first, at most two
  productDomain: string; // short, e.g. "payments", "creator tools"
  domainRequired: boolean; // the posting REQUIRES experience in that domain
  yearsRequired: number | null; // years of PM experience asked, null if unstated
  hardRequirements: string[]; // must-haves as written, short
  managesPMs: boolean; // people management of PMs is required
  companyStage: CompanyStage;
  aiFirstStartup: boolean; // an AI-native startup (product is AI itself)
  engineeringInDisguise: boolean; // PM title, engineering substance
  deepMlRequired: boolean; // model training / ML infra depth required
  descriptionAvailable: boolean;
  analyzedAt: string;
}

const SYSTEM = `You read one job posting and extract facts about what it asks for. You are not scoring any candidate.
Answer ONLY with a JSON object, no prose, using exactly these keys:
{
  "archetypes": [<1 or 2 of: ${ARCHETYPE_IDS.join(", ")}>],
  "productDomain": "<2-4 words naming the product area, e.g. 'payments', 'creator tools', 'developer APIs'>",
  "domainRequired": <true only if the posting REQUIRES prior experience in that specific domain; "preferred"/"nice to have"/"bonus" is false>,
  "yearsRequired": <number of years of product management experience required, the minimum if a range, null if not stated>,
  "hardRequirements": [<up to 5 must-haves exactly as the posting states them, each under 15 words>],
  "managesPMs": <true only if the role requires managing other product managers>,
  "companyStage": "<established|growth|seed|unknown>",
  "aiFirstStartup": <true if the company is a startup whose core product IS AI (not a company adding AI features)>,
  "engineeringInDisguise": <true if despite a PM title the role's substance is engineering: owns architecture, writes production code, reports into engineering>,
  "deepMlRequired": <true if it requires model training, fine-tuning, or ML infrastructure depth, not just applied LLM product work>
}
Archetype meanings: ${ARCHETYPE_IDS.map((a) => `${a} = ${ARCHETYPES[a]}`).join("; ")}.
companyStage: "established" = public, large or late-stage; "growth" = venture-backed with real revenue (Series B-D); "seed" = pre-seed to Series A; "unknown" if the posting doesn't say. Judge from the posting's own words only -- do not guess from the company name.`;

export type AnalysisCache = Record<string, RoleAnalysis>;

export function loadCache(path: string): AnalysisCache {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as AnalysisCache;
}

export function saveCache(path: string, cache: AnalysisCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 1));
}

/** Plain text from whatever the adapter stored (some older rows are escaped HTML). */
export function cleanDescription(raw: string | null): string {
  if (!raw) return "";
  return decodeEntities(stripHtml(decodeEntities(raw))).replace(/\s+/g, " ").trim();
}

export interface RoleInput {
  id: number;
  title: string;
  company: string;
  description: string | null;
  contentHash: string;
}

export async function analyzeRole(role: RoleInput): Promise<RoleAnalysis> {
  const description = cleanDescription(role.description).slice(0, 6000);
  const raw = (await jsonCall(
    SYSTEM,
    `Company: ${role.company}\nTitle: ${role.title}\nPosting:\n${description || "(no description available -- use the title only, and say unknown where you can't tell)"}`,
  )) as Record<string, unknown>;

  const archetypes = (Array.isArray(raw.archetypes) ? raw.archetypes : []).filter(isArchetype).slice(0, 2);
  const years = Number(raw.yearsRequired);
  const stage = String(raw.companyStage ?? "unknown");
  return {
    contentHash: role.contentHash,
    archetypes: archetypes.length > 0 ? archetypes : ["b2b-saas"],
    productDomain: String(raw.productDomain ?? "").slice(0, 60),
    domainRequired: raw.domainRequired === true,
    yearsRequired: Number.isFinite(years) && years > 0 ? years : null,
    hardRequirements: (Array.isArray(raw.hardRequirements) ? raw.hardRequirements : []).map(String).slice(0, 5),
    managesPMs: raw.managesPMs === true,
    companyStage: stage === "established" || stage === "growth" || stage === "seed" ? stage : "unknown",
    aiFirstStartup: raw.aiFirstStartup === true,
    engineeringInDisguise: raw.engineeringInDisguise === true,
    deepMlRequired: raw.deepMlRequired === true,
    descriptionAvailable: description.length > 200,
    analyzedAt: new Date().toISOString(),
  };
}
