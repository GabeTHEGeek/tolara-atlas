/**
 * scripts/analyze-roles.ts
 * Reads every live role on the map that has no current analysis in
 * data/role-analysis.json, so the quiz-based match score on the public site
 * (src/quizMatch.ts) can score it. scripts/match-resume.ts only analyses the
 * roles near the top of ONE resume's list; visitors need all of them.
 *
 *   npx tsx scripts/analyze-roles.ts --dry-run     # count what's missing, no model calls
 *   npx tsx scripts/analyze-roles.ts [--limit 500]  # analyse, newest roles first
 *
 * Uses the paid model (the copilot's provider, server/agent/providers.ts):
 * one call per role, about $0.0005 each on DeepSeek. Run it by hand, never
 * from the nightly sync -- the sync stays free of paid services. Then commit
 * data/role-analysis.json; the nightly export ships the facts to the browser
 * (server/export/matchFacts.ts).
 *
 * An analysis counts as current under the same rule match-resume.ts uses:
 * the posting's content_hash hasn't changed, and it isn't a title-only read
 * of a posting whose text has since arrived.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../server/db/client.js";
import { analyzeRole, cleanDescription, loadCache, saveCache } from "../server/match/analyzeRole.js";
import { mapLimit } from "../server/match/llm.js";
import type { MapData } from "../src/types.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = path.join(ROOT, "data", "role-analysis.json");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("limit") ?? Infinity);

  // The roles the site shows: US roles on the map or in the unmapped list.
  const mapData = JSON.parse(readFileSync(path.join(ROOT, "public", "data", "map-data.json"), "utf-8")) as MapData;
  const shown = new Map<number, { title: string; company: string; firstSeenAt: string }>();
  for (const pin of mapData.pins) for (const r of pin.roles) shown.set(r.id, { title: r.title.trim(), company: pin.companyName, firstSeenAt: r.firstSeenAt });
  for (const c of mapData.remoteCompanies) for (const r of c.roles) shown.set(r.id, { title: r.title.trim(), company: c.companyName, firstSeenAt: r.firstSeenAt });

  const db = getDb();
  const rows = db.prepare(`SELECT id, description, content_hash FROM roles WHERE status = 'active'`).all() as Array<{
    id: number;
    description: string | null;
    content_hash: string;
  }>;
  const cache = loadCache(CACHE_PATH);
  const current = (r: (typeof rows)[number]) => {
    const a = cache[String(r.id)];
    if (!a || a.contentHash !== r.content_hash) return false;
    return a.descriptionAvailable || cleanDescription(r.description).length <= 200;
  };

  const live = rows.filter((r) => shown.has(r.id));
  const missing = live
    .filter((r) => !current(r))
    // Newest first: a role that just went up is the one a visitor is most
    // likely to act on.
    .sort((a, b) => shown.get(b.id)!.firstSeenAt.localeCompare(shown.get(a.id)!.firstSeenAt));
  const todo = missing.slice(0, limit);
  const stale = missing.filter((r) => cache[String(r.id)]).length;
  console.log(`${live.length} live roles; ${live.length - missing.length} analysed and current; ${missing.length} to analyse (${stale} stale, ${missing.length - stale} never analysed)`);
  console.log(`About ${todo.length} model calls, roughly $${(todo.length * 0.0005).toFixed(2)} on DeepSeek`);
  if (dryRun || todo.length === 0) return;

  let done = 0;
  let failed = 0;
  await mapLimit(todo, 8, async (r) => {
    const role = shown.get(r.id)!;
    try {
      cache[String(r.id)] = await analyzeRole({ id: r.id, title: role.title, company: role.company, description: r.description, contentHash: r.content_hash });
    } catch {
      failed++;
    }
    if (++done % 25 === 0) {
      saveCache(CACHE_PATH, cache);
      console.log(`  ${done}/${todo.length}`);
    }
  });
  saveCache(CACHE_PATH, cache);
  console.log(`Analysed ${todo.length - failed} roles${failed ? `; ${failed} failed (re-run to retry)` : ""}. Saved to data/role-analysis.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
