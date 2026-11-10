/**
 * match/scoresFile.ts
 * The candidate's match scores as the app reads them: one file in the
 * gitignored .local/, written by scripts/match-resume.ts and read by the
 * dev server (scoresPlugin.ts) and the voice agent.
 *
 * It's personal -- scored against one resume and one set of onboarding
 * answers -- so it never goes in data/tolara.db, which the nightly job
 * commits. A --company run merges its roles into the file rather than
 * replacing everyone else's.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./rubric.js";
import type { MatchScore } from "./score.js";

export const SCORES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".local", "match-scores.json");

export interface StoredScore {
  score: number;
  tier: MatchScore["tier"];
  capped: string | null;
  categories: Array<{ id: string; label: string; points: number; max: number; counted: boolean; evidence: string }>;
}

export interface ScoresFile {
  generatedAt: string;
  candidate: string;
  answers: string | null; // the answers file used, or null for generic onboarding
  roles: Record<string, StoredScore>;
}

export function toStored(s: MatchScore): StoredScore {
  return {
    score: s.score,
    tier: s.tier,
    capped: s.capped,
    categories: s.categories.map((c) => ({ ...c, label: CATEGORIES.find((x) => x.id === c.id)!.label })),
  };
}

export function readScores(file = SCORES_PATH): ScoresFile | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as ScoresFile;
  } catch {
    return null;
  }
}

/** Writes `roles` over what's stored. Scores from different answers don't mix: a change of answers starts over. */
export function writeScores(next: Omit<ScoresFile, "generatedAt">, merge: boolean, file = SCORES_PATH): void {
  const current = readScores(file);
  const keep = merge && current && current.answers === next.answers && current.candidate === next.candidate ? current.roles : {};
  writeFileSync(file, JSON.stringify({ ...next, generatedAt: new Date().toISOString(), roles: { ...keep, ...next.roles } }));
}
