/**
 * scripts/find-people.ts
 * Runs "Find people" for a list of roles from the command line, the same
 * code path as the button, one role after another in one LinkedIn window:
 *
 *   npx tsx scripts/find-people.ts 1142 923 4872
 *
 * Results land in .local/contacts-cache.json like a click's would, and a
 * readable summary in .local/find-people-report.md. Each role still gets at
 * most three searches; between roles it waits a further 20-40 seconds, so
 * a batch reads as someone working through a list, not a crawler.
 */

import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { getDb } from "../server/db/client.js";
import { findPeople, type ContactsResult } from "../server/contacts/findPeople.js";
import { LOCAL_DIR, LinkedInStop, closeBrowser } from "../server/contacts/linkedin.js";

loadDotenv();

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (ids.length === 0) {
  console.error("usage: npx tsx scripts/find-people.ts <roleId> [roleId...]");
  process.exit(1);
}

const db = getDb();
const results: ContactsResult[] = [];
const failures: Array<{ roleId: number; error: string }> = [];

for (const [i, roleId] of ids.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, 20_000 + Math.random() * 20_000));
  console.log(`\n[${i + 1}/${ids.length}] role ${roleId}`);
  try {
    const result = await findPeople(db, roleId, (m) => console.log(`  ${m}`));
    results.push(result);
    console.log(`  -> ${result.people.length} people`);
    for (const p of result.people) console.log(`     ${p.label} (${p.confidence}) ${p.name} — ${p.reason}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ roleId, error: message });
    console.log(`  !! ${message}`);
    // LinkedIn put something in the way: stop the whole batch, never retry.
    if (err instanceof LinkedInStop) break;
  }
}
await closeBrowser();

const lines = [`# Find people — ${new Date().toISOString()}`, ""];
for (const r of results) {
  lines.push(`## ${r.company} — ${r.roleTitle} (role ${r.roleId})`);
  lines.push(`reports to: ${r.hints.reportsTo ?? "—"} · team: ${r.hints.team ?? "—"}`);
  lines.push(`searches: ${r.searches.map((s) => `${s.kind} "${s.keywords}" (${s.results})`).join(" · ")}`);
  for (const p of r.people) lines.push(`- **${p.name}** · ${p.label} · ${p.confidence} — ${p.headline} — ${p.reason} — ${p.url}`);
  if (r.people.length === 0) lines.push("- (no one)");
  lines.push("");
}
for (const f of failures) lines.push(`- role ${f.roleId} failed: ${f.error}`);
const out = path.join(LOCAL_DIR, "find-people-report.md");
fs.writeFileSync(out, lines.join("\n"));
console.log(`\nreport: ${out}`);
process.exit(0);
