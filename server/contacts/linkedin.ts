/**
 * contacts/linkedin.ts
 * Drives one real, headed Chromium signed in to the owner's LinkedIn, in a
 * dedicated profile under the gitignored .local/ -- never their everyday
 * Chrome profile.
 *
 * Automating LinkedIn is against its user agreement; the owner accepted
 * that risk on these terms, which this file is what enforces:
 *   - on demand only, one role per click, at most three searches;
 *   - search results pages only, never profile pages;
 *   - human pacing: seconds between actions, with jitter;
 *   - the password is never typed or stored here -- the first run opens
 *     the login page and waits for the owner to sign in by hand;
 *   - a CAPTCHA, security check or restriction page stops everything and
 *     is reported, never worked around or retried.
 *
 * Results are read as text, not by class name: LinkedIn's markup changes
 * often and its classes are obfuscated (see extractPeople/extractPosts for
 * what is stable). The model makes sense of the text afterwards.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_DIR = process.env.TOLARA_LOCAL_DIR ?? path.join(__dirname, "..", "..", ".local");
const PROFILE_DIR = path.join(LOCAL_DIR, "linkedin-browser");

const SIGN_IN_WAIT_MS = 5 * 60_000;
// Close the window once it's been idle this long; the profile keeps the
// session, so the next click just reopens it signed in.
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_RESULTS_PER_SEARCH = 10;

export type StopReason = "signed_out" | "checkpoint" | "restricted" | "sign_in_timeout" | "browser_closed";

/** Something LinkedIn put in the way. Never retried. */
export class LinkedInStop extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
  ) {
    super(message);
  }
}

export interface PersonResult {
  name: string;
  profileUrl: string;
  text: string; // the result card's visible text: headline, location, snippets
}

export interface PostResult {
  postUrl: string | null;
  authorName: string | null;
  authorUrl: string | null;
  text: string; // author line, relative date, and the post itself (truncated)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A human-ish pause: `base` seconds plus up to `spread` more, at random. */
const pause = (base: number, spread: number) => sleep((base + Math.random() * spread) * 1000);

let context: BrowserContext | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function openContext(): Promise<BrowserContext> {
  if (context) return context;
  // Imported lazily so a static build, or a dev server that never uses
  // this, doesn't load Playwright at all.
  const { chromium } = await import("playwright");
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  ctx.on("close", () => {
    if (context === ctx) context = null;
  });
  context = ctx;
  return ctx;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const ctx = context;
  context = null;
  await ctx?.close().catch(() => {});
}

async function getPage(): Promise<Page> {
  const ctx = await openContext();
  touchIdle();
  return ctx.pages()[0] ?? (await ctx.newPage());
}

/**
 * What the current page is, as far as this agent cares. Checked after
 * every navigation: the earliest sign of a checkpoint is the one to act on.
 */
async function classify(page: Page): Promise<"ok" | "login" | StopReason> {
  const url = page.url();
  if (/\/checkpoint\/|\/challenge\b|captcha/i.test(url)) return "checkpoint";
  if (/\/(login|uas\/login|authwall|signup)\b/i.test(url) || /linkedin\.com\/?(\?|$)/.test(url)) return "login";
  const text = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 4000);
  if (/your account (has been|is) (temporarily )?restricted|account restricted|we've restricted your account/i.test(text)) {
    return "restricted";
  }
  if (/let's do a quick security check|unusual activity|verify you're a human|complete this puzzle/i.test(text)) {
    return "checkpoint";
  }
  if (/\bsign in\b/i.test(text) && /\bjoin now\b/i.test(text) && !/\bmessaging\b/i.test(text)) return "login";
  return "ok";
}

function stopFor(state: StopReason): LinkedInStop {
  switch (state) {
    case "checkpoint":
      return new LinkedInStop(
        state,
        "LinkedIn is showing a security check. Finish it yourself in the LinkedIn window, then try again later — Tolara won't touch it.",
      );
    case "restricted":
      return new LinkedInStop(state, "LinkedIn says this account is restricted. Tolara has stopped and won't search again.");
    case "signed_out":
      return new LinkedInStop(state, "LinkedIn signed you out. Click Find people again to sign in.");
    case "sign_in_timeout":
      return new LinkedInStop(state, "Didn't see a LinkedIn sign-in within 5 minutes. Click Find people to try again.");
    case "browser_closed":
      return new LinkedInStop(state, "The LinkedIn window was closed.");
  }
}

/**
 * Makes sure the window is signed in. If it isn't, opens the login page and
 * waits -- up to five minutes -- for the owner to sign in by hand. Nothing
 * is typed into the form from here.
 */
export async function ensureSignedIn(onStatus: (message: string) => void): Promise<void> {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await pause(2, 1.5);
  let state = await classify(page);
  if (state === "ok") return;
  if (state !== "login") throw stopFor(state);

  if (!/\/login/.test(page.url())) await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  onStatus("Sign in to LinkedIn in the window that just opened. Tolara is waiting (up to 5 minutes).");

  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (page.isClosed()) throw stopFor("browser_closed");
    const url = page.url();
    // Still on the form, or LinkedIn's own two-step verification: both are
    // the owner's to complete, so keep waiting rather than calling it a stop.
    if (/\/(login|uas\/login)\b/.test(url)) continue;
    if (/\/checkpoint\/challenge|\/checkpoint\/lg\//.test(url)) continue;
    state = await classify(page);
    if (state === "ok" && /\/feed|\/in\/|\/mynetwork|\/search/.test(url)) return;
    if (state === "restricted") throw stopFor(state);
  }
  throw stopFor("sign_in_timeout");
}

async function openSearch(url: string): Promise<Page> {
  const page = await getPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pause(2.5, 2);
  const state = await classify(page);
  if (state === "login") throw stopFor("signed_out");
  if (state !== "ok") throw stopFor(state);
  // Scroll the way a reader would, so lazily rendered results load.
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 500 + Math.random() * 400);
    await pause(0.8, 1.2);
  }
  return page;
}

function cleanText(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(connect|follow|message|view .* profile|status is (online|offline)|•|…more|see more)$/i.test(l))
    // LinkedIn repeats the name for screen readers ("Jane Doe\nView Jane Doe's profile").
    .filter((l, i, all) => all.indexOf(l) === i)
    .join(" · ")
    .slice(0, 600);
}

/**
 * People results, read in the page. LinkedIn's 2026 search page has no
 * list items and obfuscated classes; what's stable is that each result's
 * name link reads "Jane Doe • 2nd", and that mutual-connection links (also
 * to /in/) don't. A card is the largest box around the name link that
 * holds only one such degree marker.
 *
 * Self-contained (no outside references) because Playwright serializes it
 * into the page.
 */
export function extractPeople(max: number) {
  const DEGREE = /•\s*(1st|2nd|3rd\+?)/g;
  const root = document.querySelector("main") ?? document.body;
  const seen = new Set<string>();
  const out: Array<{ name: string; profileUrl: string; text: string }> = [];
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))) {
    const m = a.href.match(/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/);
    if (!m || seen.has(m[0])) continue;
    if (!/•\s*(1st|2nd|3rd)/.test(a.innerText)) continue;
    let card: HTMLElement = a;
    while (card.parentElement && card.parentElement !== root && (card.parentElement.innerText.match(DEGREE) ?? []).length <= 1) {
      card = card.parentElement;
    }
    const name = a.innerText.split("\n")[0].trim();
    if (!name || /^LinkedIn Member/i.test(name)) continue;
    seen.add(m[0]);
    out.push({ name, profileUrl: m[0], text: card.innerText });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Post results. Each post carries a visually hidden "Feed post" heading;
 * the card is the largest box around one with no second heading in it.
 * Most posts don't expose a permalink on the results page (it's behind the
 * "..." menu), so the author's profile is often the only link.
 */
export function extractPosts(max: number) {
  const root = document.querySelector("main") ?? document.body;
  const isHeading = (e: Element) => e.childElementCount === 0 && e.textContent?.trim() === "Feed post";
  const headings = (el: Element) => Array.from(el.querySelectorAll("*")).filter(isHeading).length;
  const out: Array<{ postUrl: string | null; authorName: string | null; authorUrl: string | null; text: string }> = [];
  for (const h of Array.from(root.querySelectorAll("*")).filter(isHeading)) {
    let card = h as HTMLElement;
    while (card.parentElement && card.parentElement !== root && headings(card.parentElement) <= 1) card = card.parentElement;
    const author = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).find((a) => a.innerText.trim());
    const permalink = card.querySelector<HTMLAnchorElement>('a[href*="/feed/update/"], a[href*="/posts/"]');
    out.push({
      postUrl: permalink ? permalink.href.split("?")[0] : null,
      authorName: author ? author.innerText.split("\n")[0].trim() : null,
      authorUrl: author?.href.match(/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/)?.[0] ?? null,
      text: card.innerText.replace(/^\s*Feed post\s*/, ""),
    });
    if (out.length >= max) break;
  }
  return out;
}

export async function searchPeople(keywords: string): Promise<PersonResult[]> {
  const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
  const page = await openSearch(url);
  const raw = await page.evaluate(extractPeople, MAX_RESULTS_PER_SEARCH);
  return raw.map((r) => ({ ...r, text: cleanText(r.text) }));
}

export async function searchPosts(keywords: string): Promise<PostResult[]> {
  const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
  const page = await openSearch(url);
  const raw = await page.evaluate(extractPosts, MAX_RESULTS_PER_SEARCH);
  return raw.map((r) => ({ ...r, text: cleanText(r.text).slice(0, 700) }));
}

/** Seconds between searches: long enough to read a page, never a fixed beat. */
export const betweenSearches = () => pause(4, 5);
