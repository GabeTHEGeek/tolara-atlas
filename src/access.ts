/**
 * access.ts
 * Who may open the board. Signing up on the landing page (or saying you
 * already have, with your email) unlocks the board in that browser, and the
 * browser remembers it, so a returning visitor goes straight in. A new
 * device, another browser or cleared site data shows the signup again, where
 * "Already signed up?" takes just an email.
 *
 * This is a lead-capture gate, not security: the site is static files and
 * the job data is public, so anyone determined can get around it. Only a
 * "yes" and the time are stored here, never the email.
 *
 * With no Kit form configured (KIT_FORM_ID unset, e.g. a fresh clone) there
 * is nothing to sign up to, so the board stays open.
 */

import { KIT_FORM_ID } from "./kit.js";

const KEY = "tolara.access.v1";
const RETURN_KEY = "tolara.returnTo";

export const GATE_ON = KIT_FORM_ID != null;

export function hasAccess(): boolean {
  if (!GATE_ON) return true;
  try {
    return localStorage.getItem(KEY) != null;
  } catch {
    // Storage blocked (some private windows): nothing can be remembered, so
    // don't lock someone out of a board they can't be let into.
    return true;
  }
}

export function grantAccess(): void {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    /* blocked: hasAccess() already says yes in this case */
  }
}

/** Where a gated visitor was headed (a shared role link, say), to go there once they're in. */
export function rememberReturnTo(hash: string): void {
  if (!hash || hash === "#/" || hash.startsWith("#/welcome")) return;
  try {
    sessionStorage.setItem(RETURN_KEY, hash);
  } catch {
    /* blocked */
  }
}

export function takeReturnTo(): string {
  try {
    const to = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (to && to.startsWith("#/")) return to;
  } catch {
    /* blocked */
  }
  return "#/jobs";
}
