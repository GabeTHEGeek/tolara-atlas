import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Client side of "Find people" (server/contacts/). One shared store, so the
 * job board's badges and the role page's panel see the same run: start it
 * from a card, open role prep, and the progress is already there.
 *
 * The endpoint only exists under `npm run dev`; a static build answers the
 * status check with a 404 or its index.html, which reads as `local: false`.
 */

export type ContactLabel = "hiring_manager" | "team_pm" | "recruiter" | "other";

export interface Contact {
  name: string;
  headline: string;
  label: ContactLabel;
  reason: string;
  url: string;
  source: "people" | "post";
  confidence: "high" | "medium" | "low";
}

export interface ContactsResult {
  roleId: number;
  hints: { reportsTo: string | null; team: string | null };
  searches: Array<{ kind: "people" | "posts"; keywords: string; why: string; results: number }>;
  people: Contact[];
  foundAt: string;
}

export interface ContactsJob {
  roleId: number;
  state: "running" | "done" | "error" | "stopped";
  message: string;
  startedAt: string;
  result?: ContactsResult;
}

interface State {
  local: boolean | null; // null until the first status check answers
  counts: Record<string, number>;
  job: ContactsJob | null;
  blocked: string | null;
}

let state: State = { local: null, counts: {}, job: null, blocked: null };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

let polling = false;
let checked = false;

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/contacts/status");
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return set({ local: false });
    const body = (await res.json()) as { counts: Record<string, number>; job: ContactsJob | null; blocked: string | null };
    set({ local: true, counts: body.counts, job: body.job, blocked: body.blocked });
  } catch {
    set({ local: false });
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    do {
      await new Promise((r) => setTimeout(r, 1500));
      await refresh();
    } while (state.job?.state === "running");
  } finally {
    polling = false;
  }
}

export async function findPeople(roleId: number): Promise<void> {
  set({ job: { roleId, state: "running", message: "Starting…", startedAt: new Date().toISOString() } });
  try {
    const res = await fetch("/api/contacts/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: roleId }),
    });
    const body = (await res.json().catch(() => ({}))) as { job?: ContactsJob; message?: string };
    if (!res.ok) {
      // Busy with another role: show that run rather than a fake one.
      set({ job: body.job?.state === "running" ? body.job : { roleId, state: "error", message: body.message ?? `HTTP ${res.status}`, startedAt: new Date().toISOString() } });
      if (res.status === 423) set({ blocked: body.message ?? "Blocked" });
      if (res.status === 409) void poll();
      return;
    }
    set({ job: body.job ?? null });
    void poll();
  } catch {
    set({ local: false, job: null });
  }
}

export function useContacts(): State {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (checked) return;
    checked = true;
    void refresh().then(() => {
      if (state.job?.state === "running") void poll();
    });
  }, []);
  return snapshot;
}

/** The cached result for one role, refetched when a run for it finishes. */
export function useRoleContacts(roleId: number): { result: ContactsResult | null; job: ContactsJob | null; local: boolean | null; blocked: string | null } {
  const { local, job, blocked } = useContacts();
  const [result, setResult] = useState<ContactsResult | null>(null);
  const roleJob = job?.roleId === roleId ? job : null;
  const finished = roleJob?.state === "done" ? roleJob.result ?? null : null;

  useEffect(() => {
    setResult(null);
    if (!local) return;
    let cancelled = false;
    fetch(`/api/contacts?role=${roleId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { result: ContactsResult | null } | null) => !cancelled && body && setResult(body.result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roleId, local]);

  return { result: finished ?? result, job: roleJob, local, blocked };
}
