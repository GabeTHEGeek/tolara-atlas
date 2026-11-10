/**
 * match/check.ts
 * The one per-candidate model step: for a shortlisted role, does the
 * candidate meet its hard requirements? Only the top of the code-scored
 * list reaches this, so a match costs a few dozen calls, not thousands.
 *
 * Carries Maester's guardrails: keyword overlap isn't evidence, applied AI
 * product work isn't deep ML, and tenure comes from date ranges (already
 * computed into the profile) -- never from milestone timeframes in bullets.
 * The reason has to quote both sides, so a verdict can be checked.
 */

import { createHash } from "node:crypto";
import type { RoleAnalysis } from "./analyzeRole.js";
import { cleanDescription } from "./analyzeRole.js";
import { countedYears, type CandidateProfile } from "./profile.js";
import { jsonCall } from "./llm.js";

export interface RequirementsCheck {
  status: "met" | "one_stretch" | "unmet";
  reason: string;
  degreeGap: boolean; // the posting requires a degree the resume doesn't show as completed
}

const SYSTEM = `You check whether a candidate meets a job's HARD requirements -- the must-haves, not the nice-to-haves.
Rules:
- Keyword overlap is not evidence. Credit a requirement only when the candidate's resume shows it -- read every job's bullets, not just the summary.
- Applied AI product work (prompt engineering, LLM orchestration, agents, API integration) is not deep ML (model training, fine-tuning, ML infrastructure). If the job requires deep ML and the candidate shows only applied work, that is unmet.
- Years of experience are given as computed facts -- use them, do not recount from bullets. Use the "counted" figure for a general PM-years requirement.
- A requirement for years of a SPECIFIC kind of work ("4 years driving consumer growth", "3 years in payments") is met only by the jobs whose titles and dates show that work -- add up those jobs' date ranges, never the candidate's total years. Up to one year short is a stretch; more than a year short is unmet.
- Skills listed on the resume count as evidence for a skill requirement ("SQL proficiency").
- If the posting states no hard requirements at all, you cannot confirm them: answer "one_stretch" and say so.
- A required degree the resume doesn't show as completed is a stretch, never unmet. If the posting offers an alternative the candidate meets (e.g. "or equivalent experience"), it is met.
- A specific tool or language the resume doesn't show (Python, Figma, Salesforce) is a stretch, never unmet -- it can be learned; a missing kind of experience can't.
- A required domain the candidate hasn't worked in is a stretch, not automatically unmet, unless the posting makes it a hard gate.
Answer ONLY with JSON: {"status": "<met|one_stretch|unmet>", "reason": "<one sentence quoting the decisive requirement and the candidate evidence (or its absence)>", "degreeGap": <true if the posting requires a degree the resume doesn't show as completed, with no alternative the candidate meets>}
"met" = nothing hard is missing; "one_stretch" = exactly one hard requirement is a stretch; "unmet" = a hard requirement is clearly not met.`;

/** Changes whenever the rules above do, so cached verdicts from older rules aren't reused. */
export const CHECK_VERSION = createHash("sha256").update(SYSTEM).digest("hex").slice(0, 8);

export async function checkRequirements(
  profile: CandidateProfile,
  role: { title: string; company: string; description: string | null },
  analysis: RoleAnalysis,
  resumeText = "",
): Promise<RequirementsCheck> {
  const candidate = [
    `Years in product roles: ${countedYears(profile)} counted (${profile.employedPmYears} employed PM in full, ${profile.founderYears} as founder/head of product at two-thirds; ${profile.totalYears} calendar years)`,
    `Jobs: ${profile.jobs.map((j) => `${j.title} at ${j.company} (${j.start} to ${j.end ?? "present"})`).join("; ")}`,
    `Archetypes: ${profile.archetypes.map((a) => `${a.archetype} -- "${a.evidence}"`).join("; ")}`,
    `Highlights: ${profile.highlights.join("; ")}`,
    `Skills listed: ${profile.skills?.join(", ") || "(none listed)"}`,
    `ML depth: ${profile.mlDepth}. Managed people: ${profile.managedPeople ? "yes" : "no"}.`,
    // The summary above drops most bullets (a 3D identity and social
    // platform, a co-streaming feature), so the check reads the resume too.
    resumeText ? `Resume:\n${resumeText.slice(0, 7000)}` : "",
  ].join("\n");
  const job = [
    `${role.title} at ${role.company}`,
    `Hard requirements extracted: ${analysis.hardRequirements.join("; ") || "(none extracted)"}`,
    `Years required: ${analysis.yearsRequired ?? "not stated"}`,
    `Posting excerpt: ${cleanDescription(role.description).slice(0, 3500) || "(no description available)"}`,
  ].join("\n");

  const raw = (await jsonCall(SYSTEM, `CANDIDATE:\n${candidate}\n\nJOB:\n${job}`)) as Record<string, unknown>;
  const status = String(raw.status);
  return {
    status: status === "met" || status === "one_stretch" || status === "unmet" ? status : "one_stretch",
    reason: String(raw.reason ?? "").slice(0, 300),
    degreeGap: raw.degreeGap === true,
  };
}
