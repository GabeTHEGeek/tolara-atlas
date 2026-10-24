/**
 * match/profile.ts
 * A resume, read once into the facts the rubric needs: the jobs held (with
 * dates), the PM archetypes the candidate has actually done, product
 * domains, where they're based, and their strongest evidence.
 *
 * The model only lists jobs and their stated dates; years are added up
 * here in code from those date ranges. That's Maester's tenure rule made
 * structural -- a bullet like "hit X in the first 4 months" can never be
 * mistaken for how long someone held the job.
 *
 * The resume text is never written anywhere by this module.
 */

import { ARCHETYPES, ARCHETYPE_IDS, isArchetype, type Archetype } from "./archetypes.js";
import { jsonCall } from "./llm.js";

export interface ResumeJob {
  company: string;
  title: string;
  start: string; // "YYYY-MM"
  end: string | null; // null = present
  founder: boolean;
}

export interface CandidateProfile {
  name: string;
  location: { city: string; state: string } | null;
  jobs: ResumeJob[];
  totalYears: number; // union of all product-role date ranges
  employedPmYears: number; // PM roles at companies the candidate didn't found
  founderYears: number;
  archetypes: Array<{ archetype: Archetype; strength: "primary" | "some"; evidence: string }>;
  domains: string[];
  highlights: string[]; // strongest quantified evidence, as written
  mlDepth: "none" | "applied" | "deep";
  managedPeople: boolean;
}

const SYSTEM = `You read a resume and extract facts. Do not evaluate the candidate.
Answer ONLY with a JSON object, no prose, using exactly these keys:
{
  "name": "<full name>",
  "location": {"city": "<city>", "state": "<2-letter US state, or country>"} or null,
  "jobs": [{"company": "...", "title": "...", "start": "YYYY-MM", "end": "YYYY-MM" or null if present, "founder": <true if co-founder/founder>}],
  "archetypes": [{"archetype": "<one of: ${ARCHETYPE_IDS.join(", ")}>", "strength": "<primary|some>", "evidence": "<the resume line that shows it, under 25 words>"}],
  "domains": [<up to 6 product domains the candidate has shipped in, 2-4 words each>],
  "highlights": [<up to 6 strongest quantified results, quoted closely from the resume>],
  "mlDepth": "<none|applied|deep: applied = prompt engineering, LLM orchestration, agents, API integration; deep = model training, fine-tuning or ML infrastructure>",
  "managedPeople": <true if the resume shows directly managing people>
}
Only list jobs that are product roles (product manager, head of product, founder running product) -- include them all with their stated date ranges.
Be strict about archetypes -- they decide which jobs count as the same kind of product:
- "primary": the candidate OWNED that kind of product as the main focus of a role, or built it in two or more projects.
- "some": they shipped meaningful work of that kind in one role or project.
- Never infer an archetype from a skill or a tool: running A/B tests, analytics, SQL or "data schemas" is not the data-platform archetype; using APIs is not the platform archetype.
List at most 5 archetypes.
Archetype meanings: ${ARCHETYPE_IDS.map((a) => `${a} = ${ARCHETYPES[a]}`).join("; ")}.`;

function monthIndex(ym: string): number | null {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

/** Total months covered by a set of [start, end) month ranges, overlaps counted once. */
function unionMonths(ranges: Array<[number, number]>): number {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function yearsFrom(jobs: ResumeJob[], now = Date.now()): { total: number; employed: number; founder: number } {
  const d = new Date(now);
  const nowIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const range = (j: ResumeJob): [number, number] | null => {
    const s = monthIndex(j.start);
    const e = j.end ? monthIndex(j.end) : nowIndex;
    return s == null || e == null ? null : [s, e];
  };
  const all = jobs.map(range).filter((r): r is [number, number] => r != null);
  const employed = jobs.filter((j) => !j.founder).map(range).filter((r): r is [number, number] => r != null);
  const founder = jobs.filter((j) => j.founder).map(range).filter((r): r is [number, number] => r != null);
  const toYears = (months: number) => Math.round((months / 12) * 10) / 10;
  return { total: toYears(unionMonths(all)), employed: toYears(unionMonths(employed)), founder: toYears(unionMonths(founder)) };
}

export async function parseResume(resumeText: string): Promise<CandidateProfile> {
  const raw = (await jsonCall(SYSTEM, `RESUME:\n${resumeText.slice(0, 12000)}`)) as Record<string, unknown>;
  const jobs: ResumeJob[] = (Array.isArray(raw.jobs) ? raw.jobs : []).map((j: Record<string, unknown>) => ({
    company: String(j.company ?? ""),
    title: String(j.title ?? ""),
    start: String(j.start ?? ""),
    end: j.end ? String(j.end) : null,
    founder: j.founder === true,
  }));
  const years = yearsFrom(jobs);
  const loc = raw.location as { city?: string; state?: string } | null;
  const mlDepth = String(raw.mlDepth ?? "none");
  return {
    name: String(raw.name ?? ""),
    location: loc?.city ? { city: String(loc.city), state: String(loc.state ?? "") } : null,
    jobs,
    totalYears: years.total,
    employedPmYears: years.employed,
    founderYears: years.founder,
    archetypes: (Array.isArray(raw.archetypes) ? raw.archetypes : [])
      .filter((a: Record<string, unknown>) => isArchetype(a.archetype))
      .map((a: Record<string, unknown>) => ({
        archetype: a.archetype as Archetype,
        strength: a.strength === "primary" ? ("primary" as const) : ("some" as const),
        evidence: String(a.evidence ?? ""),
      })),
    domains: (Array.isArray(raw.domains) ? raw.domains : []).map(String).slice(0, 6),
    highlights: (Array.isArray(raw.highlights) ? raw.highlights : []).map(String).slice(0, 6),
    mlDepth: mlDepth === "applied" || mlDepth === "deep" ? mlDepth : "none",
    managedPeople: raw.managedPeople === true,
  };
}
