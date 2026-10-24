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

import type { RoleAnalysis } from "./analyzeRole.js";
import { cleanDescription } from "./analyzeRole.js";
import type { CandidateProfile } from "./profile.js";
import { jsonCall } from "./llm.js";

export interface RequirementsCheck {
  status: "met" | "one_stretch" | "unmet";
  reason: string;
}

const SYSTEM = `You check whether a candidate meets a job's HARD requirements -- the must-haves, not the nice-to-haves.
Rules:
- Keyword overlap is not evidence. Credit a requirement only when the candidate's jobs, highlights or archetype evidence show it.
- Applied AI product work (prompt engineering, LLM orchestration, agents, API integration) is not deep ML (model training, fine-tuning, ML infrastructure). If the job requires deep ML and the candidate shows only applied work, that is unmet.
- Years of experience are given as computed facts -- use them, do not recount from bullets.
- A degree line is never a failed requirement.
- A required domain the candidate hasn't worked in is a stretch, not automatically unmet, unless the posting makes it a hard gate.
Answer ONLY with JSON: {"status": "<met|one_stretch|unmet>", "reason": "<one sentence quoting the decisive requirement and the candidate evidence (or its absence)>"}
"met" = nothing hard is missing; "one_stretch" = exactly one hard requirement is a stretch; "unmet" = a hard requirement is clearly not met.`;

export async function checkRequirements(
  profile: CandidateProfile,
  role: { title: string; company: string; description: string | null },
  analysis: RoleAnalysis,
): Promise<RequirementsCheck> {
  const candidate = [
    `Years in product roles: ${profile.totalYears} total (${profile.employedPmYears} employed PM, ${profile.founderYears} as founder/head of product)`,
    `Jobs: ${profile.jobs.map((j) => `${j.title} at ${j.company} (${j.start} to ${j.end ?? "present"})`).join("; ")}`,
    `Archetypes: ${profile.archetypes.map((a) => `${a.archetype} -- "${a.evidence}"`).join("; ")}`,
    `Highlights: ${profile.highlights.join("; ")}`,
    `ML depth: ${profile.mlDepth}. Managed people: ${profile.managedPeople ? "yes" : "no"}.`,
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
  };
}
