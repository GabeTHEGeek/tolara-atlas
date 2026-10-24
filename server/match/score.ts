/**
 * match/score.ts
 * The rubric, scored in code. No model calls here: everything comes from
 * the role's exported facts (seniority, band, offices), its cached analysis
 * (analyzeRole.ts), the candidate's profile and preferences, and -- for the
 * shortlist only -- the requirements check (check.ts).
 *
 * A role with no analysis yet still scores, with neutral values for the
 * unknowns; that provisional score is what picks which roles get analysed.
 * Every category returns one line of evidence, so a score can always be
 * explained.
 */

import { isAdjacent, type Archetype } from "./archetypes.js";
import type { RoleAnalysis } from "./analyzeRole.js";
import type { CandidateProfile } from "./profile.js";
import type { RequirementsCheck } from "./check.js";
import {
  ANCHORS,
  CATEGORIES,
  ENGINEERING_CAP,
  ESTABLISHED_EMPLOYEES,
  RAW_MAX,
  TOP_BRAND_EMPLOYEES,
  tierOf,
  type CategoryId,
  type Preferences,
  type Tier,
} from "./rubric.js";

export interface RoleFacts {
  id: number;
  title: string;
  company: string;
  companySlug: string;
  url: string | null;
  seniority: "associate" | "mid" | "senior" | "principal" | "director";
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  isRemote: boolean;
  cities: string[]; // "New York, NY"
  employees: number | null; // from the company intelligence cache, when known
}

export interface CategoryScore {
  id: CategoryId;
  points: number;
  max: number;
  evidence: string;
}

export interface MatchScore {
  score: number; // 0-100
  raw: number; // out of RAW_MAX
  tier: Tier;
  capped: string | null; // why the engineering cap applied, if it did
  provisional: boolean; // no analysis yet: unknowns scored neutrally
  categories: CategoryScore[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z, ]/g, "").trim();

function scoreDomain(profile: CandidateProfile, a: RoleAnalysis | null): [number, string] {
  if (!a) return [ANCHORS.domain.adjacent, "Not analysed yet -- scored as adjacent until the posting is read"];
  const domainWords = new Set(norm(a.productDomain).split(/[ ,/]+/).filter((w) => w.length > 3));
  const domainOverlap = profile.domains.find((d) => norm(d).split(/[ ,/]+/).some((w) => domainWords.has(w)));
  // v2: a new domain the posting REQUIRES is 0, however familiar the kind of
  // work -- a data PM role at a biotech that requires life-sciences
  // experience isn't a match because the candidate has done data work.
  if (a.domainRequired && !domainOverlap) {
    return [ANCHORS.domain.newRequired, `Requires ${a.productDomain} experience, which your resume doesn't show`];
  }
  // Only an archetype the candidate has done as a main focus counts as the
  // "same kind of product"; one they've touched counts as adjacent.
  const primary = profile.archetypes.filter((x) => x.strength === "primary");
  const mine = profile.archetypes.map((x) => x.archetype);
  // The role's MAIN archetype has to match: almost anything AI-adjacent
  // picks up "ai-agents" as a secondary, which made every such role a full
  // match. And a posting read from its title alone can't prove a match.
  const same = primary.some((p) => p.archetype === a.archetypes[0]) ? a.archetypes[0] : undefined;
  if (same && !a.descriptionAvailable) {
    return [ANCHORS.domain.adjacent, `Looks like ${same} work from the title, but there's no posting text to confirm`];
  }
  if (same) {
    const ev = primary.find((x) => x.archetype === same)?.evidence ?? "";
    return [ANCHORS.domain.same, `Same kind of product (${same})${ev ? `: "${ev}"` : ""}`];
  }
  const touched = a.archetypes.find((r) => mine.includes(r));
  const adj = a.archetypes.flatMap((r) => primary.filter((m) => isAdjacent(r, m.archetype)).map((m) => [r, m.archetype] as [Archetype, Archetype]))[0];
  if (touched) return [ANCHORS.domain.adjacent, `You've touched ${touched} work, not as a main focus`];
  if (adj || domainOverlap) {
    return [
      ANCHORS.domain.adjacent,
      adj ? `Adjacent: role is ${adj[0]}, you've done ${adj[1]}` : `Adjacent domain: ${a.productDomain} ~ ${domainOverlap}`,
    ];
  }
  return a.domainRequired
    ? [ANCHORS.domain.newRequired, `New domain (${a.productDomain}) and the posting requires it`]
    : [ANCHORS.domain.newPreferred, `New domain (${a.productDomain}), only preferred`];
}

const AI_TITLE = /\b(ai|ml|llm|agent|agents|agentic|genai)\b|forward[- ]deployed/i;

function scoreCompany(role: RoleFacts, a: RoleAnalysis | null, prefs: Preferences): [number, string] {
  if (a?.aiFirstStartup && prefs.skipAiFirstStartups && AI_TITLE.test(role.title) && (role.employees ?? 0) < ESTABLISHED_EMPLOYEES) {
    return [ANCHORS.company.aiFirstStartupAiTitle, "AI-first startup hiring an AI / forward-deployed title (you chose to skip these)"];
  }
  if (role.employees != null && role.employees >= ESTABLISHED_EMPLOYEES) {
    return [ANCHORS.company.established, `Established: about ${role.employees.toLocaleString()} employees`];
  }
  switch (a?.companyStage) {
    case "established":
      return [ANCHORS.company.established, "Established or late stage, per the posting"];
    case "growth":
      return [ANCHORS.company.growth, "Growth stage with revenue, per the posting"];
    case "seed":
      return [ANCHORS.company.seed, "Seed / early stage, per the posting"];
    default:
      return [ANCHORS.company.unknown, "Company stage unknown -- scored as growth"];
  }
}

function scoreLevel(role: RoleFacts, a: RoleAnalysis | null): [number, string] {
  const t = role.title.toLowerCase();
  const topBrand = (role.employees ?? 0) >= TOP_BRAND_EMPLOYEES;
  if (a?.managesPMs) return [ANCHORS.level.poor, "Requires managing PMs"];
  if (role.seniority === "director") return [ANCHORS.level.poor, "Director-level or above"];
  if (/\bstaff\b/.test(t)) return [ANCHORS.level.poor, "Staff title"];
  if (role.seniority === "associate") return [ANCHORS.level.poor, "Associate level -- under your level"];
  if (/group product manager|\bgpm\b/.test(t)) return [ANCHORS.level.partial, "Group PM without required reports"];
  // roleFacets files "Lead" under senior; the rubric scores a Lead IC like
  // a Principal, so it's checked by title here.
  if (role.seniority === "principal" || /\blead (product manager|pm)\b|\bproduct lead\b/.test(t)) {
    return [ANCHORS.level.strong, "Lead / Principal IC"];
  }
  if (topBrand) return [ANCHORS.level.strong, `${role.seniority === "senior" ? "Sr PM" : "PM"} at a top brand`];
  return [ANCHORS.level.partial, `${role.seniority === "senior" ? "Sr PM" : "PM"} at a mid-size company`];
}

function scoreRequirements(profile: CandidateProfile, a: RoleAnalysis | null, check: RequirementsCheck | null): [number, string] {
  // Unknown isn't met: with no posting text there's nothing to check the
  // candidate against, so it scores as one stretch until it can be read.
  if (a && !a.descriptionAvailable) {
    return [ANCHORS.requirements.oneStretch, "Can't confirm requirements -- the posting text isn't available"];
  }
  let points: number = ANCHORS.requirements.met;
  let why = "No years stated";
  if (a?.yearsRequired != null) {
    const gap = a.yearsRequired - profile.totalYears;
    if (gap <= 0.5) why = `${a.yearsRequired}+ years asked, you have ${profile.totalYears}`;
    else if (gap <= 2) [points, why] = [ANCHORS.requirements.oneStretch, `${a.yearsRequired}+ years asked, you have ${profile.totalYears} -- a stretch`];
    else [points, why] = [ANCHORS.requirements.unmet, `${a.yearsRequired}+ years asked, you have ${profile.totalYears}`];
  }
  if (check) {
    const fromCheck = check.status === "met" ? ANCHORS.requirements.met : check.status === "one_stretch" ? ANCHORS.requirements.oneStretch : ANCHORS.requirements.unmet;
    if (fromCheck < points) {
      points = fromCheck;
      why = check.reason;
    } else if (check.status === "met") why = `${why}; must-haves met: ${check.reason}`;
  }
  return [points, why];
}

function inList(city: string, list: string[]): boolean {
  const c = norm(city);
  return list.some((l) => norm(l) === c);
}

function scoreLocation(role: RoleFacts, prefs: Preferences): [number, string] {
  const remoteOk = prefs.preferredLocations.some((l) => /remote/i.test(l));
  if (role.isRemote && remoteOk) return [ANCHORS.location.preferred, "Remote US"];
  const preferred = role.cities.find((c) => inList(c, prefs.preferredLocations));
  if (preferred) return [ANCHORS.location.preferred, preferred];
  const secondary = role.cities.find((c) => inList(c, prefs.secondaryLocations));
  if (secondary) return [ANCHORS.location.secondary, secondary];
  if (prefs.relocationOk) return [ANCHORS.location.secondary, `${role.cities[0] ?? "Elsewhere"} (you're open to relocating)`];
  return [ANCHORS.location.other, role.cities.slice(0, 2).join(" / ") || "Location not listed"];
}

function scoreComp(role: RoleFacts, prefs: Preferences): [number, string] {
  const yearlyUsd = (role.salaryPeriod ?? "year") === "year" && (role.salaryCurrency ?? "USD") === "USD";
  const top = yearlyUsd ? (role.salaryMax ?? role.salaryMin) : null;
  if (top == null) {
    const large = (role.employees ?? 0) >= ESTABLISHED_EMPLOYEES;
    return large ? [ANCHORS.comp.unpostedLarge, "Pay not posted (large company)"] : [ANCHORS.comp.unpostedSmall, "Pay not posted"];
  }
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (top >= prefs.payTarget) return [ANCHORS.comp.atTarget, `Top of band ${k(top)} -- at or above your ${k(prefs.payTarget)} target`];
  if (top >= prefs.payFloor) return [ANCHORS.comp.betweenFloorAndTarget, `Top of band ${k(top)}`];
  return [ANCHORS.comp.belowFloor, `Top of band ${k(top)} -- under your ${k(prefs.payFloor)} floor`];
}

export function scoreRole(
  role: RoleFacts,
  profile: CandidateProfile,
  prefs: Preferences,
  analysis: RoleAnalysis | null,
  check: RequirementsCheck | null = null,
): MatchScore {
  const results: Record<CategoryId, [number, string]> = {
    domain: scoreDomain(profile, analysis),
    company: scoreCompany(role, analysis, prefs),
    level: scoreLevel(role, analysis),
    requirements: scoreRequirements(profile, analysis, check),
    location: scoreLocation(role, prefs),
    comp: scoreComp(role, prefs),
  };
  const categories = CATEGORIES.map((c) => ({ id: c.id, max: c.max, points: results[c.id][0], evidence: results[c.id][1] }));
  const raw = categories.reduce((sum, c) => sum + c.points, 0);
  let score = Math.round((raw * 100) / RAW_MAX);

  let capped: string | null = null;
  if (analysis?.engineeringInDisguise) capped = "Engineering role with a PM title";
  else if (analysis?.deepMlRequired && profile.mlDepth !== "deep") capped = "Requires deep ML depth your resume doesn't show";
  if (capped) score = Math.min(score, ENGINEERING_CAP);

  return { score, raw, tier: tierOf(score), capped, provisional: analysis == null, categories };
}
