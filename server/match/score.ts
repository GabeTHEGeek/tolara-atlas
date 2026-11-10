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
 * explained. A category the candidate has no preference on returns null and
 * isn't counted: the score is scaled over the categories that are.
 */

import { isAdjacent, type Archetype } from "./archetypes.js";
import type { RoleAnalysis } from "./analyzeRole.js";
import { countedYears, type CandidateProfile } from "./profile.js";
import type { RequirementsCheck } from "./check.js";
import {
  ANCHORS,
  CATEGORIES,
  ENGINEERING_CAP,
  ESTABLISHED_EMPLOYEES,
  LEVEL_ORDER,
  TOP_BRAND_EMPLOYEES,
  levelFromYears,
  tierOf,
  type CategoryId,
  type Level,
  type Preferences,
  type StagePreference,
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
  counted: boolean; // false: no preference given, left out of the score
  evidence: string;
}

export interface MatchScore {
  score: number; // 0-100
  raw: number; // out of rawMax
  rawMax: number; // the counted categories' maximums
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
  // Applied AI is a way of building, not a kind of product: AI agents in a
  // developer tool or infrastructure product aren't the same work as AI in
  // the consumer or marketplace products the candidate built. So an
  // "ai-agents" match also needs the role's other kind of product to be one
  // the candidate has done.
  if (same === "ai-agents" && a.archetypes.length > 1 && !mine.includes(a.archetypes[1])) {
    return [ANCHORS.domain.adjacent, `AI work, but in ${a.archetypes[1]} products, which you haven't built`];
  }
  // "Consumer" is the broadest kind of product: a consumer health or travel
  // app isn't the same work as the consumer apps the candidate built unless
  // the product area or another of the role's kinds of product matches too.
  if (
    same === "consumer" &&
    !domainOverlap &&
    !a.archetypes.slice(1).some((r) => primary.some((p) => p.archetype === r))
  ) {
    return [ANCHORS.domain.adjacent, `Consumer product, but in ${a.productDomain}, which you haven't worked in`];
  }
  if (same && !a.descriptionAvailable) {
    return [ANCHORS.domain.adjacent, `Looks like ${same} work from the title, but there's no posting text to confirm`];
  }
  if (same) {
    const ev = primary.find((x) => x.archetype === same)?.evidence ?? "";
    return [ANCHORS.domain.same, `Same kind of product (${same})${ev ? `: "${ev}"` : ""}`];
  }
  // The product area itself matches ("social and identity" ~ "web3
  // identity & social") and the role's kinds of product include one the
  // candidate has made a main focus: that's the same work, even when the
  // posting's main archetype is a neighbour (platform, here).
  const sharedPrimary = a.archetypes.find((r) => primary.some((p) => p.archetype === r));
  if (domainOverlap && sharedPrimary && a.descriptionAvailable) {
    return [ANCHORS.domain.same, `Same product area: ${a.productDomain} ~ your ${domainOverlap} (${sharedPrimary})`];
  }
  if (sharedPrimary) return [ANCHORS.domain.adjacent, `Your main focus (${sharedPrimary}) is this role's secondary area`];
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

type Scored = [number, string] | null;

const STAGE_ORDER: StagePreference[] = ["established", "growth", "seed"];
const STAGE_LABEL: Record<StagePreference, string> = { established: "Established", growth: "Growth stage", seed: "Early stage" };

function scoreCompany(role: RoleFacts, a: RoleAnalysis | null, prefs: Preferences): Scored {
  if (a?.aiFirstStartup && prefs.skipAiFirstStartups && AI_TITLE.test(role.title) && (role.employees ?? 0) < ESTABLISHED_EMPLOYEES) {
    return [ANCHORS.company.aiFirstStartupAiTitle, "AI-first startup hiring an AI / forward-deployed title (you chose to skip these)"];
  }
  if (!prefs.companyStage) {
    return prefs.skipAiFirstStartups ? [ANCHORS.company.noStagePreference, "Not an AI-first startup role"] : null;
  }
  let stage: StagePreference | null = null;
  let why = "";
  if (role.employees != null && role.employees >= ESTABLISHED_EMPLOYEES) {
    [stage, why] = ["established", `about ${role.employees.toLocaleString()} employees`];
  } else if (a && a.companyStage !== "unknown") {
    [stage, why] = [a.companyStage, "per the posting"];
  }
  if (!stage) return [ANCHORS.company.unknown, "Company stage unknown -- scored halfway"];
  const away = Math.abs(STAGE_ORDER.indexOf(stage) - STAGE_ORDER.indexOf(prefs.companyStage));
  const points = [ANCHORS.company.sameStage, ANCHORS.company.oneStageAway, ANCHORS.company.twoStagesAway][away];
  return [points, `${STAGE_LABEL[stage]}, ${why}${away === 0 ? " -- the kind you asked for" : ""}`];
}

const LEVEL_LABEL: Record<Level, string> = {
  associate: "Associate",
  mid: "PM",
  senior: "Sr PM",
  principal: "Lead / Principal",
  director: "Group PM / Director",
};

/** The role's level, from its seniority facet and title. */
function roleLevel(role: RoleFacts, a: RoleAnalysis | null): Level {
  const t = role.title.toLowerCase();
  if (a?.managesPMs || role.seniority === "director") return "director";
  // roleFacets files "Lead" and "Staff" under senior; they're principal-
  // level ICs, as is a Group PM without required reports.
  if (role.seniority === "principal" || /\bstaff\b|\blead (product manager|pm)\b|\bproduct lead\b|group product manager|\bgpm\b/.test(t)) return "principal";
  return role.seniority;
}

function scoreLevel(role: RoleFacts, a: RoleAnalysis | null, profile: CandidateProfile, prefs: Preferences): [number, string] {
  const targets = prefs.targetLevels ?? [levelFromYears(countedYears(profile), profile.managedPeople)];
  const level = roleLevel(role, a);
  if (a?.managesPMs && !profile.managedPeople) return [ANCHORS.level.poor, "Requires managing PMs, which your resume doesn't show"];
  // The gap to the nearest level the candidate would take.
  const at = LEVEL_ORDER.indexOf(level);
  let gap = targets.map((t) => at - LEVEL_ORDER.indexOf(t)).reduce((best, g) => (Math.abs(g) < Math.abs(best) ? g : best));
  // A title at a top brand carries the next level's scope elsewhere.
  const topBrand = gap < 0 && (role.employees ?? 0) >= TOP_BRAND_EMPLOYEES;
  if (topBrand) gap += 1;
  const label = `${LEVEL_LABEL[level]}${topBrand ? " at a top brand" : ""}`;
  const aim = targets.map((t) => LEVEL_LABEL[t]).join(" / ");
  // The quiz's Director answer means no reports required: a role that
  // requires managing PMs is at best partial, whoever has managed people.
  if (gap === 0 && a?.managesPMs) return [ANCHORS.level.partial, `${label} -- requires managing PMs`];
  if (gap === 0) return [ANCHORS.level.strong, `${label} -- you're aiming for ${aim}`];
  if (Math.abs(gap) === 1) return [ANCHORS.level.partial, `${label} -- one level ${gap > 0 ? "above" : "below"} ${aim}`];
  return [ANCHORS.level.poor, `${label} -- ${gap > 0 ? "well above" : "well below"} ${aim}`];
}

// Requirements no resume can show: a role gated on these is unmet unless
// the candidate's resume says otherwise, which the check can't confirm
// either. Read from the analysis's extracted must-haves.
const HARD_GATE = /\b(security clearance|ts\/sci|top secret|polygraph|secret clearance|active clearance)\b/i;

function scoreRequirements(profile: CandidateProfile, a: RoleAnalysis | null, check: RequirementsCheck | null): [number, string] {
  // Unknown isn't met: with no posting text there's nothing to check the
  // candidate against, so it scores as one stretch until it can be read.
  if (a && !a.descriptionAvailable) {
    return [ANCHORS.requirements.oneStretch, "Can't confirm requirements -- the posting text isn't available"];
  }
  const gate = a?.hardRequirements.find((r) => HARD_GATE.test(r));
  if (gate) return [ANCHORS.requirements.unmet, `Requires: "${gate}"`];
  // Only a check against the resume can say requirements are met. Before
  // one runs -- and when the posting lists nothing to check -- the best a
  // role can do is one stretch; years still pull it lower.
  let points: number = check && a && a.hardRequirements.length > 0 ? ANCHORS.requirements.met : ANCHORS.requirements.oneStretch;
  let why = !a || a.hardRequirements.length > 0 ? "Not checked against your resume yet" : "The posting lists no requirements to check";
  if (a?.yearsRequired != null) {
    const years = countedYears(profile);
    const gap = a.yearsRequired - years;
    if (gap <= 0.5) why = `${a.yearsRequired}+ years asked, you have ${years}${points < ANCHORS.requirements.met ? " -- the rest not checked yet" : ""}`;
    else if (gap <= 2) [points, why] = [ANCHORS.requirements.oneStretch, `${a.yearsRequired}+ years asked, you have ${years} -- a stretch`];
    else [points, why] = [ANCHORS.requirements.unmet, `${a.yearsRequired}+ years asked, you have ${years}`];
  }
  if (check) {
    const fromCheck =
      check.status === "unmet" ? ANCHORS.requirements.unmet
      : check.degreeGap ? ANCHORS.requirements.degreeGap
      : check.status === "one_stretch" ? ANCHORS.requirements.oneStretch
      : ANCHORS.requirements.met;
    if (fromCheck < points) {
      points = fromCheck;
      why = check.reason;
    } else if (check.status === "met") why = why.startsWith("Not checked") ? `Must-haves met: ${check.reason}` : `${why}; must-haves met: ${check.reason}`;
  }
  return [points, why];
}

function inList(city: string, list: string[]): boolean {
  const c = norm(city);
  return list.some((l) => norm(l) === c);
}

function scoreLocation(role: RoleFacts, prefs: Preferences): Scored {
  const loc = prefs.locations;
  if (!loc) return null;
  const remoteOk = loc.preferred.some((l) => /remote/i.test(l));
  if (role.isRemote && remoteOk) return [ANCHORS.location.preferred, "Remote US"];
  const preferred = role.cities.find((c) => inList(c, loc.preferred));
  if (preferred) return [ANCHORS.location.preferred, preferred];
  const secondary = role.cities.find((c) => inList(c, loc.secondary));
  if (secondary) return [ANCHORS.location.secondary, secondary];
  if (loc.relocationOk) return [ANCHORS.location.secondary, `${role.cities[0] ?? "Elsewhere"} (you're open to relocating)`];
  return [ANCHORS.location.other, role.cities.slice(0, 2).join(" / ") || "Location not listed"];
}

function scoreComp(role: RoleFacts, prefs: Preferences): Scored {
  if (!prefs.pay) return null;
  const { floor, target } = prefs.pay;
  const yearlyUsd = (role.salaryPeriod ?? "year") === "year" && (role.salaryCurrency ?? "USD") === "USD";
  const top = yearlyUsd ? (role.salaryMax ?? role.salaryMin) : null;
  if (top == null) {
    const large = (role.employees ?? 0) >= ESTABLISHED_EMPLOYEES;
    return large ? [ANCHORS.comp.unpostedLarge, "Pay not posted (large company)"] : [ANCHORS.comp.unpostedSmall, "Pay not posted"];
  }
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (top >= target) return [ANCHORS.comp.atTarget, `Top of band ${k(top)} -- at or above your ${k(target)} target`];
  if (top >= floor) return [ANCHORS.comp.betweenFloorAndTarget, `Top of band ${k(top)}`];
  return [ANCHORS.comp.belowFloor, `Top of band ${k(top)} -- under your ${k(floor)} floor`];
}

export function scoreRole(
  role: RoleFacts,
  profile: CandidateProfile,
  prefs: Preferences,
  analysis: RoleAnalysis | null,
  check: RequirementsCheck | null = null,
): MatchScore {
  const results: Record<CategoryId, Scored> = {
    domain: scoreDomain(profile, analysis),
    company: scoreCompany(role, analysis, prefs),
    level: scoreLevel(role, analysis, profile, prefs),
    requirements: scoreRequirements(profile, analysis, check),
    location: scoreLocation(role, prefs),
    comp: scoreComp(role, prefs),
  };
  const categories = CATEGORIES.map((c) => {
    const r = results[c.id];
    return { id: c.id, max: c.max, counted: r != null, points: r?.[0] ?? 0, evidence: r?.[1] ?? "No preference -- not counted" };
  });
  const counted = categories.filter((c) => c.counted);
  const raw = counted.reduce((sum, c) => sum + c.points, 0);
  const rawMax = counted.reduce((sum, c) => sum + c.max, 0);
  let score = Math.round((raw * 100) / rawMax);

  let capped: string | null = null;
  if (analysis?.engineeringInDisguise) capped = "Engineering role with a PM title";
  else if (analysis?.deepMlRequired && profile.mlDepth !== "deep") capped = "Requires deep ML depth your resume doesn't show";
  if (capped) score = Math.min(score, ENGINEERING_CAP);

  return { score, raw, rawMax, tier: tierOf(score), capped, provisional: analysis == null, categories };
}
