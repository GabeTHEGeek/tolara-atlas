/**
 * base.ts
 * Where the site is served from: "/" locally, "/tolara-atlas/" on GitHub
 * Pages. Vite sets it from `base` in vite.config.ts (which reads SITE_URL),
 * so data files load from the right place wherever the site is hosted.
 */

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export const BASE = env.BASE_URL ?? "/";

/** A file under public/, e.g. dataUrl("data/map-data.json"). */
export function dataUrl(path: string): string {
  return `${BASE}${path.replace(/^\//, "")}`;
}
