/**
 * quizMatch.ts
 * The match score for anyone, from a short quiz instead of a resume. The
 * answers stay in this browser (localStorage); scoring runs here too, with
 * the same rubric the owner's resume matcher uses (server/match/score.ts),
 * against the analysed roles in public/data/match-facts.json.
 *
 * What a quiz can't do is check a role's must-haves against a resume, so
 * Requirements scores the way an unchecked role does on the owner's machine:
 * at best one stretch, lower when the years asked are more than you have.
 */

import { ARCHETYPES, type Archetype } from "../server/match/archetypes.js";
import type { CandidateProfile } from "../server/match/candidate.js";
import { GENERIC_ANSWERS, METROS, preferencesFrom, type Answers } from "../server/match/onboarding.js";
import { CATEGORIES } from "../server/match/rubric.js";
import { scoreRole, type RoleFacts } from "../server/match/score.js";
import type { RoleAnalysis } from "../server/match/analyzeRole.js";
import type { RoleScore } from "./scores.js";
import { dataUrl } from "./base.js";

export { ARCHETYPES, METROS };
export type { Archetype };

export interface QuizAnswers extends Answers {
  pmYears: number; // years working as a PM (not counting founding a company)
  founderYears: number; // years as founder / head of product at your own company
  primary: Archetype[]; // kinds of product that were a main focus
  some: Archetype[]; // kinds of product you've shipped some work in
  domains: string; // free text, comma separated: "payments, healthcare"
  mlDepth: "none" | "applied" | "deep";
  managedPeople: boolean;
}

export const DEFAULT_QUIZ: QuizAnswers = {
  ...GENERIC_ANSWERS,
  pmYears: 3,
  founderYears: 0,
  primary: [],
  some: [],
  domains: "",
  mlDepth: "none",
  managedPeople: false,
};

const KEY = "tolara.matchQuiz.v1";

export function readQuiz(): QuizAnswers | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_QUIZ, ...(JSON.parse(raw) as Partial<QuizAnswers>) } : null;
  } catch {
    return null;
  }
}

export function writeQuiz(answers: QuizAnswers | null): void {
  try {
    if (answers) localStorage.setItem(KEY, JSON.stringify(answers));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: the score still works until the tab closes */
  }
}

export function profileFrom(q: QuizAnswers): CandidateProfile {
  const employed = Math.max(0, q.pmYears);
  const founder = Math.max(0, q.founderYears);
  const primary = q.primary.slice(0, 3);
  return {
    name: "",
    location: null,
    jobs: [],
    // Assumes the two never overlapped; countedYears caps at this total.
    totalYears: employed + founder,
    employedPmYears: employed,
    founderYears: founder,
    archetypes: [
      ...primary.map((archetype) => ({ archetype, strength: "primary" as const, evidence: "" })),
      ...q.some.filter((a) => !primary.includes(a)).map((archetype) => ({ archetype, strength: "some" as const, evidence: "" })),
    ],
    domains: q.domains.split(/[,;\n]/).map((d) => d.trim()).filter(Boolean).slice(0, 6),
    highlights: [],
    mlDepth: q.mlDepth,
    managedPeople: q.managedPeople,
  };
}

// score.ts was written for a resume; say what a quiz actually told us.
function reword(evidence: string): string {
  return evidence
    .replace(/which your resume doesn't show/g, "which isn't in your quiz answers")
    .replace(/your resume doesn't show/g, "your quiz answers don't include")
    .replace("Not checked against your resume yet", "Must-haves not checked -- that needs a resume")
    .replace(" -- the rest not checked yet", " -- other must-haves not checked");
}

interface FactsFile {
  generatedAt: string;
  roles: Array<{ facts: RoleFacts; analysis: Omit<RoleAnalysis, "contentHash" | "analyzedAt"> }>;
}

let facts: Promise<FactsFile | null> | null = null;

function loadFacts(): Promise<FactsFile | null> {
  facts ??= fetch(dataUrl("data/match-facts.json"))
    .then((r) => (r.ok ? (r.json() as Promise<FactsFile>) : null))
    .catch(() => null);
  return facts;
}

/** Every analysed role scored against these answers, with the breakdown the role page shows. */
export async function scoreQuiz(q: QuizAnswers): Promise<Map<number, RoleScore>> {
  const file = await loadFacts();
  const out = new Map<number, RoleScore>();
  if (!file) return out;
  const profile = profileFrom(q);
  const prefs = preferencesFrom(q);
  for (const { facts: f, analysis } of file.roles) {
    const a: RoleAnalysis = { ...analysis, contentHash: "", analyzedAt: "" };
    const s = scoreRole(f, profile, prefs, a);
    out.set(f.id, {
      score: s.score,
      tier: s.tier,
      capped: s.capped ? reword(s.capped) : null,
      categories: s.categories.map((c) => ({ ...c, label: CATEGORIES.find((x) => x.id === c.id)!.label, evidence: reword(c.evidence) })),
    });
  }
  return out;
}
