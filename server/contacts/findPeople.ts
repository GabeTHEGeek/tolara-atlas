/**
 * contacts/findPeople.ts
 * One click of "Find people": read the posting, run at most three LinkedIn
 * searches, have the model keep the 3-5 people worth contacting, cache it.
 *
 * Results are personal data about real people and the owner's own
 * LinkedIn view, so they're cached in the gitignored .local/ and never in
 * data/tolara.db -- the nightly job commits that file to a public repo.
 * Nothing here guesses an email address or anything else the search
 * results didn't show.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { chat } from "../agent/providers.js";
import { extractJson } from "../match/llm.js";
import { hintsFor, planSearches, type PlannedSearch, type PostingHints } from "./posting.js";
import {
  LOCAL_DIR,
  betweenSearches,
  ensureSignedIn,
  searchPeople,
  searchPosts,
  type PersonResult,
  type PostResult,
} from "./linkedin.js";

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
  company: string;
  roleTitle: string;
  hints: PostingHints;
  searches: Array<PlannedSearch & { results: number }>;
  people: Contact[];
  foundAt: string;
}

const CACHE_FILE = path.join(LOCAL_DIR, "contacts-cache.json");
const CACHE_TTL_MS = 30 * 86_400_000;

type Cache = Record<string, ContactsResult>;

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function writeCache(cache: Cache) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

const fresh = (r: ContactsResult) => Date.now() - Date.parse(r.foundAt) < CACHE_TTL_MS;

// Search results whose ranking failed (the model was down or out of
// credit), kept so "Try again" only re-runs the model: repeating the
// LinkedIn searches would cost the account more activity for nothing new.
const PENDING_FILE = path.join(LOCAL_DIR, "contacts-pending.json");
const PENDING_TTL_MS = 86_400_000;

interface PendingSearch {
  at: string;
  searches: ContactsResult["searches"];
  people: PersonResult[];
  posts: PostResult[];
}

function readPending(): Record<string, PendingSearch> {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) as Record<string, PendingSearch>;
  } catch {
    return {};
  }
}

function writePending(roleId: number, entry: PendingSearch | null) {
  const all = readPending();
  for (const [id, p] of Object.entries(all)) if (Date.now() - Date.parse(p.at) > PENDING_TTL_MS) delete all[id];
  if (entry) all[String(roleId)] = entry;
  else delete all[String(roleId)];
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(all));
}

export function cachedContacts(roleId: number): ContactsResult | null {
  const hit = readCache()[String(roleId)];
  return hit && fresh(hit) ? hit : null;
}

/** People-found counts per role, for the job board's badges. */
export function cachedCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, r] of Object.entries(readCache())) if (fresh(r) && r.people.length > 0) out[id] = r.people.length;
  return out;
}

export interface RoleRow {
  id: number;
  title: string;
  description: string | null;
  company: string;
}

export function loadRole(db: Database.Database, roleId: number): RoleRow | null {
  return (
    (db
      .prepare(
        `SELECT r.id, r.title, r.description, c.name AS company
           FROM roles r JOIN companies c ON c.id = r.company_id
          WHERE r.id = ?`,
      )
      .get(roleId) as RoleRow | undefined) ?? null
  );
}

// Ranking writes a few thousand tokens of JSON; the provider layer's 20s
// default is sized for spoken replies and timed out on a quarter of runs.
const RANK_TIMEOUT_MS = 90_000;

const SYSTEM = `You pick the people a job seeker should contact about one specific Product Manager opening.
You get the role, what the posting says about its manager and team, and raw LinkedIn search results (people cards and posts).
Rules:
- Make sure it is the SAME company: several companies share names (Odyssey, Socket, Helius...). Use the "About the company" text from the posting to tell them apart, and drop people at a different company that happens to have the same name.
- Keep only people who appear to work at the hiring company NOW: their current headline/title names the company (or an obvious product of it), or a recent post of theirs is about hiring at it. Drop anyone whose card says "Past:" / "former" / "ex-" for this company, or who is clearly at another company.
- Never invent anyone or anything. Every person must come from the results, with the URL given there. Never guess emails.
- Label each: "hiring_manager" (holds or closely matches the title the role reports to, or posted that they're hiring for this team), "team_pm" (a PM/product person on the same team or product area), "recruiter" (recruiter/talent partner covering product or tech roles at the company), "other" (relevant product leader, otherwise).
- A post by someone at the company announcing they're hiring a PM is the strongest signal; prefer it, and use the post URL.
- Rank best first. Return 3-5 people if that many qualify; fewer (even zero) if not -- never pad with people at other companies.
- reason: one short line, specific and factual, e.g. "Holds the Director of PM, Pricing title the posting reports to" or "Posted about hiring a PM for Payments, 2w ago".
- confidence: "high" when the title or post matches the role's manager or team directly, "medium" for a plausible product leader, "low" for a weak guess.
Answer with JSON only: {"people":[{"name":"","headline":"","label":"","reason":"","url":"","source":"people|post","confidence":""}]}`;

function promptFor(role: RoleRow, hints: PostingHints, people: PersonResult[], posts: PostResult[]): string {
  const lines = [
    `Company: ${role.company}`,
    `About the company (start of the posting): ${(role.description ?? "").replace(/\s+/g, " ").slice(0, 500) || "not available"}`,
    `Role: ${role.title}`,
    `Reports to (from posting): ${hints.reportsTo ?? "not stated"}`,
    `Team/product (from title or posting): ${hints.team ?? "not stated"}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "PEOPLE RESULTS:",
    ...people.map((p, i) => `P${i + 1}. ${p.name} | ${p.profileUrl} | ${p.text}`),
    "",
    "POST RESULTS:",
    ...posts.map(
      (p, i) =>
        `T${i + 1}. author: ${p.authorName ?? "?"} (${p.authorUrl ?? "no profile link"}) | post: ${p.postUrl ?? "no link"} | ${p.text}`,
    ),
  ];
  return lines.join("\n");
}

const LABELS = new Set<ContactLabel>(["hiring_manager", "team_pm", "recruiter", "other"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

/** Keeps only people whose URL actually appeared in the results. */
function validate(raw: unknown, people: PersonResult[], posts: PostResult[]): Contact[] {
  const known = new Set<string>([
    ...people.map((p) => p.profileUrl),
    ...posts.flatMap((p) => [p.postUrl, p.authorUrl].filter((u): u is string => Boolean(u))),
  ]);
  const list = (raw as { people?: unknown })?.people;
  if (!Array.isArray(list)) return [];
  const out: Contact[] = [];
  for (const item of list) {
    const p = item as Record<string, unknown>;
    const url = typeof p.url === "string" ? p.url.trim().replace(/\/$/, "") : "";
    const match = [...known].find((k) => k.replace(/\/$/, "") === url);
    if (!match || typeof p.name !== "string" || !p.name.trim()) continue;
    if (out.some((o) => o.url === match || o.name === p.name)) continue;
    out.push({
      name: p.name.trim(),
      headline: typeof p.headline === "string" ? p.headline.trim().slice(0, 160) : "",
      label: LABELS.has(p.label as ContactLabel) ? (p.label as ContactLabel) : "other",
      reason: typeof p.reason === "string" ? p.reason.trim().slice(0, 200) : "",
      url: match,
      source: p.source === "post" || /\/feed\/update\/|\/posts\//.test(match) ? "post" : "people",
      confidence: CONFIDENCE.has(p.confidence as string) ? (p.confidence as Contact["confidence"]) : "low",
    });
    if (out.length >= 5) break;
  }
  return out;
}

const POSTS_REUSE_MS = 86_400_000;
const recentPosts = new Map<string, { at: number; results: PostResult[] }>();

export async function findPeople(
  db: Database.Database,
  roleId: number,
  onStatus: (message: string) => void,
): Promise<ContactsResult> {
  const role = loadRole(db, roleId);
  if (!role) throw new Error(`No role ${roleId}`);

  const hints = hintsFor(role.title, role.description, null);

  const pending = readPending()[String(roleId)];
  if (pending && Date.now() - Date.parse(pending.at) < PENDING_TTL_MS) {
    onStatus(`Ranking ${pending.people.length} people and ${pending.posts.length} posts from the earlier searches…`);
    const result = await rankAndCache(role, hints, pending.searches, pending.people, pending.posts);
    writePending(roleId, null);
    return result;
  }

  const plan = planSearches(role.company, role.title, hints);
  onStatus("Opening LinkedIn…");
  await ensureSignedIn(onStatus);

  const people: PersonResult[] = [];
  const posts: PostResult[] = [];
  const searches: ContactsResult["searches"] = [];
  let searched = false;
  for (const [i, search] of plan.entries()) {
    // The posts query is company-wide, so three roles at Google would run
    // the same search three times; within a day, reuse it.
    const recent = search.kind === "posts" ? recentPosts.get(search.keywords) : undefined;
    const reuse = recent && Date.now() - recent.at < POSTS_REUSE_MS ? recent.results : null;
    if (searched && !reuse) await betweenSearches();
    searched ||= !reuse;
    onStatus(`Search ${i + 1} of ${plan.length}: ${search.kind === "posts" ? "posts" : "people"} — ${search.keywords}`);
    if (search.kind === "people") {
      const found = await searchPeople(search.keywords);
      for (const p of found) if (!people.some((q) => q.profileUrl === p.profileUrl)) people.push(p);
      searches.push({ ...search, results: found.length });
    } else {
      const found = reuse ?? (await searchPosts(search.keywords));
      if (!reuse) recentPosts.set(search.keywords, { at: Date.now(), results: found });
      posts.push(...found);
      searches.push({ ...search, results: found.length });
    }
  }

  onStatus(`Ranking ${people.length} people and ${posts.length} posts…`);
  try {
    return await rankAndCache(role, hints, searches, people, posts);
  } catch (err) {
    writePending(roleId, { at: new Date().toISOString(), searches, people, posts });
    throw err;
  }
}

/**
 * The model step and the cache write, apart from the browser so search
 * results gathered some other way (a different browser, a saved run) go
 * through the same filtering and end up in the same place.
 */
async function rank(role: RoleRow, hints: PostingHints, people: PersonResult[], posts: PostResult[]): Promise<unknown> {
  const result = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: promptFor(role, hints, people, posts) },
    ],
    [],
    { timeoutMs: RANK_TIMEOUT_MS },
  );
  return extractJson(result.content ?? "");
}

export async function rankAndCache(
  role: RoleRow,
  hints: PostingHints,
  searches: ContactsResult["searches"],
  people: PersonResult[],
  posts: PostResult[],
): Promise<ContactsResult> {
  const picked =
    people.length + posts.length > 0
      ? validate(await rank(role, hints, people, posts), people, posts)
      : [];

  const result: ContactsResult = {
    roleId: role.id,
    company: role.company,
    roleTitle: role.title,
    hints,
    searches,
    people: picked,
    foundAt: new Date().toISOString(),
  };
  const cache = readCache();
  for (const [id, r] of Object.entries(cache)) if (!fresh(r)) delete cache[id];
  cache[String(role.id)] = result;
  writeCache(cache);
  return result;
}
