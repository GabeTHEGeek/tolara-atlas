/**
 * scores.ts
 * The owner's match scores (server/match/scoresPlugin.ts), for the job
 * board's badges and sort and the role page's "Your match" card.
 *
 * Local only, like Find people: on the published site the endpoint doesn't
 * exist and every score is simply absent, so nothing personal is ever
 * shipped or shown to anyone else.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

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
}

let state: State = { local: null, roles: {}, generatedAt: null };
const listeners = new Set<() => void>();
let requested = false;

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/match/scores");
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
      state = { ...state, local: false };
    } else {
      const body = (await res.json()) as { roles: Record<string, [number, Tier]>; generatedAt: string | null };
      state = { local: true, roles: body.roles, generatedAt: body.generatedAt };
    }
  } catch {
    state = { ...state, local: false };
  }
  listeners.forEach((l) => l());
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
    void load();
  }, []);
  return snapshot;
}

/** The full breakdown for one role, or null when it hasn't been scored. */
export function useRoleScore(roleId: number): RoleScore | null {
  const { local } = useScores();
  const [score, setScore] = useState<RoleScore | null>(null);
  useEffect(() => {
    setScore(null);
    if (!local) return;
    let cancelled = false;
    fetch(`/api/match/scores?role=${roleId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { score: RoleScore | null } | null) => !cancelled && body && setScore(body.score))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roleId, local]);
  return score;
}

/** CSS modifier per tier. */
export const TIER_CLASS: Record<Tier, string> = {
  "Strong Apply": "strong",
  Apply: "apply",
  Consider: "consider",
  Pass: "pass",
};
