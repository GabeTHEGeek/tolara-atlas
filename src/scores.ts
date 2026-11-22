/**
 * scores.ts
 * Match scores for the job board's badges and sort and the role page's
 * "Your match" card, from one of two places:
 *
 *   - the quiz (quizMatch.ts): anyone's answers, kept and scored in this
 *     browser. Used whenever this browser has saved answers.
 *   - the owner's resume matcher (server/match/scoresPlugin.ts): local
 *     only, like Find people. On the published site that endpoint doesn't
 *     exist, so nothing personal is ever shipped or shown to anyone else.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { readQuiz, scoreQuiz, writeQuiz, type QuizAnswers } from "./quizMatch.js";

export type Tier = "Strong Apply" | "Apply" | "Consider" | "Pass";

export interface RoleScore {
  score: number;
  tier: Tier;
  capped: string | null;
  categories: Array<{ id: string; label: string; points: number; max: number; counted: boolean; evidence: string }>;
}

interface State {
  local: boolean | null; // null until the endpoint answers
  roles: Record<string, [number, Tier]>;
  generatedAt: string | null;
  // Where `roles` came from: the quiz in this browser, or the owner's matcher.
  source: "quiz" | "owner" | null;
  quiz: QuizAnswers | null;
}

let state: State = { local: null, roles: {}, generatedAt: null, source: null, quiz: null };
let ownerRoles: Record<string, [number, Tier]> = {};
let quizScores = new Map<number, RoleScore>();

function publish(): void {
  const roles = state.quiz ? Object.fromEntries([...quizScores].map(([id, s]) => [id, [s.score, s.tier] as [number, Tier]])) : ownerRoles;
  const source = state.quiz ? "quiz" : Object.keys(ownerRoles).length > 0 ? "owner" : null;
  state = { ...state, roles, source };
  listeners.forEach((l) => l());
}

async function rescoreQuiz(): Promise<void> {
  const q = state.quiz;
  const scored = q ? await scoreQuiz(q) : new Map<number, RoleScore>();
  if (state.quiz !== q) return; // answers changed again while scoring
  quizScores = scored;
  publish();
}

/** Save quiz answers (or null to clear them) and re-score every role. */
export async function setQuizAnswers(answers: QuizAnswers | null): Promise<void> {
  writeQuiz(answers);
  state = { ...state, quiz: answers };
  if (!answers) quizScores = new Map();
  publish();
  await rescoreQuiz();
}

// Quiz-modal open state, shared so any view can open it.
let quizOpen = false;
const quizListeners = new Set<() => void>();
export function openQuiz(open = true): void {
  quizOpen = open;
  quizListeners.forEach((l) => l());
}
export function useQuizOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      quizListeners.add(l);
      return () => quizListeners.delete(l);
    },
    () => quizOpen,
  );
}
const listeners = new Set<() => void>();
let requested = false;

// Asked again whenever the tab comes back into view: a tab opened while the
// dev server was restarting would otherwise show no scores until a reload,
// and a re-run of the matcher shows up without one.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (requested && document.visibilityState === "visible") void load();
  });
}

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/match/scores");
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
      // Keep scores already shown; a hiccup shouldn't blank the board.
      if (state.local !== true) state = { ...state, local: false };
    } else {
      const body = (await res.json()) as { roles: Record<string, [number, Tier]>; generatedAt: string | null };
      ownerRoles = body.roles;
      state = { ...state, local: true, generatedAt: body.generatedAt };
    }
  } catch {
    if (state.local !== true) state = { ...state, local: false };
  }
  publish();
}

/** Score and tier per role id; empty when there are none (or off this machine). */
export function useScores(): State {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (requested) return;
    requested = true;
    const quiz = readQuiz();
    if (quiz) {
      state = { ...state, quiz };
      void rescoreQuiz();
    }
    void load();
  }, []);
  return snapshot;
}

/** The full breakdown for one role, or null when it hasn't been scored. */
export function useRoleScore(roleId: number): RoleScore | null {
  const { local, source, roles } = useScores();
  const [score, setScore] = useState<RoleScore | null>(null);
  useEffect(() => {
    setScore(null);
    if (source === "quiz") {
      setScore(quizScores.get(roleId) ?? null);
      return;
    }
    if (!local) return;
    let cancelled = false;
    fetch(`/api/match/scores?role=${roleId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { score: RoleScore | null } | null) => !cancelled && body && setScore(body.score))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roleId, local, source, roles]);
  return score;
}

/** CSS modifier per tier. */
export const TIER_CLASS: Record<Tier, string> = {
  "Strong Apply": "strong",
  Apply: "apply",
  Consider: "consider",
  Pass: "pass",
};
