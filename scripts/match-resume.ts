/**
 * scripts/match-resume.ts
 * Scores every live role against one resume and writes a report to check
 * by hand -- the first test of the resume-match rubric, before any UI.
 *
 *   npx tsx scripts/match-resume.ts .local/resume.txt [--prefs .local/prefs.json] [--analyze 300] [--check 50]
 *
 * The flow (see server/match/*):
 *   1. Parse the resume into a profile (one model call; cached in .local/
 *      by the text's hash so re-runs don't repeat it).
 *   2. Score every role in code with neutral values for unknowns.
 *   3. Analyse the top --analyze roles that aren't cached yet (one model
 *      call each, shared by every future resume; data/role-analysis.json).
 *   4. Re-score, then check hard requirements for the top --check (one
 *      model call each, this candidate only).
 *   5. Write .local/match-report.md and .local/match-handscore.csv.
 *
 * Takes plain text or Markdown. For a PDF, extract the text first.
 * Everything personal stays in .local/, which git ignores.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../server/db/client.js";
import { readCachedIntelligence } from "../server/enrichment/intelligence.js";
import { analyzeRole, cleanDescription, loadCache, saveCache, type RoleAnalysis } from "../server/match/analyzeRole.js";
import { checkRequirements, type RequirementsCheck } from "../server/match/check.js";
import { mapLimit } from "../server/match/llm.js";
import { parseResume, type CandidateProfile } from "../server/match/profile.js";
import { CATEGORIES, type Preferences } from "../server/match/rubric.js";
import { scoreRole, type MatchScore, type RoleFacts } from "../server/match/score.js";
import type { MapData } from "../src/types.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(ROOT, ".local");
const CACHE_PATH = path.join(ROOT, "data", "role-analysis.json");

// The owner's Profile v2 values. A --prefs file overrides any of them.
const DEFAULT_PREFS: Preferences = {
  preferredLocations: [
    "Remote US",
    "New York, NY", "Brooklyn, NY",
    "Baltimore, MD", "Towson, MD", "Columbia, MD",
    "Washington, DC", "Arlington, VA", "Alexandria, VA", "McLean, VA", "Reston, VA", "Herndon, VA",
    "Tysons, VA", "Bethesda, MD", "Rockville, MD", "Silver Spring, MD",
  ],
  secondaryLocations: [
    "San Francisco, CA", "South San Francisco, CA", "Oakland, CA", "Palo Alto, CA", "Menlo Park, CA",
    "Mountain View, CA", "Sunnyvale, CA", "San Jose, CA", "Redwood City, CA", "San Mateo, CA",
    "Seattle, WA", "Bellevue, WA", "Redmond, WA", "Kirkland, WA",
  ],
  relocationOk: false,
  payFloor: 150_000,
  payTarget: 180_000,
  skipAiFirstStartups: true,
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface RoleRow {
  facts: RoleFacts;
  description: string | null;
  contentHash: string;
}

function loadRoles(): RoleRow[] {
  const db = getDb();
  const mapData = JSON.parse(readFileSync(path.join(ROOT, "public", "data", "map-data.json"), "utf-8")) as MapData;
  const dbRows = new Map(
    (db.prepare(`SELECT id, description, content_hash FROM roles WHERE status = 'active'`).all() as Array<{
      id: number;
      description: string | null;
      content_hash: string;
    }>).map((r) => [r.id, r]),
  );
  const employeesCache = new Map<number, number | null>();
  const employeesOf = (companyId: number) => {
    if (!employeesCache.has(companyId)) {
      employeesCache.set(companyId, readCachedIntelligence(db, companyId, null)?.profile?.employees ?? null);
    }
    return employeesCache.get(companyId) ?? null;
  };

  const byId = new Map<number, RoleRow>();
  const add = (role: MapData["pins"][number]["roles"][number], companyId: number, company: string, slug: string, city: string | null) => {
    const row = dbRows.get(role.id);
    if (!row) return;
    let entry = byId.get(role.id);
    if (!entry) {
      entry = {
        facts: {
          id: role.id,
          title: role.title.trim(),
          company,
          companySlug: slug,
          url: role.url,
          seniority: role.seniority,
          salaryMin: role.salaryMin,
          salaryMax: role.salaryMax,
          salaryCurrency: role.salaryCurrency,
          salaryPeriod: role.salaryPeriod,
          isRemote: false,
          cities: [],
          employees: employeesOf(companyId),
        },
        description: row.description,
        contentHash: row.content_hash,
      };
      byId.set(role.id, entry);
    }
    if (role.isRemote || !city) entry.facts.isRemote = true;
    else if (!entry.facts.cities.includes(city)) entry.facts.cities.push(city);
  };
  for (const pin of mapData.pins) {
    const city = pin.city ? (pin.state ? `${pin.city}, ${pin.state}` : pin.city) : null;
    for (const role of pin.roles) add(role, pin.companyId, pin.companyName, pin.companySlug, city);
  }
  for (const c of mapData.remoteCompanies) for (const role of c.roles) add(role, c.companyId, c.companyName, c.companySlug, null);
  return [...byId.values()];
}

async function main() {
  const resumePath = process.argv[2];
  if (!resumePath || !existsSync(resumePath)) {
    console.error("Usage: npx tsx scripts/match-resume.ts <resume.txt|.md> [--prefs file.json] [--analyze 300] [--check 50]");
    process.exit(1);
  }
  if (resumePath.toLowerCase().endsWith(".pdf")) {
    console.error("Give the resume as text or Markdown -- extract the PDF's text first.");
    process.exit(1);
  }
  mkdirSync(LOCAL, { recursive: true });
  const analyzeN = Number(arg("analyze", "300"));
  const checkN = Number(arg("check", "50"));
  const prefsPath = arg("prefs", "");
  const prefs: Preferences = prefsPath ? { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsPath, "utf-8")) } : DEFAULT_PREFS;

  // 1. Profile, cached by the resume's hash.
  const resumeText = readFileSync(resumePath, "utf-8");
  const hash = createHash("sha256").update(resumeText).digest("hex").slice(0, 16);
  const profilePath = path.join(LOCAL, `profile-${hash}.json`);
  let profile: CandidateProfile;
  if (existsSync(profilePath)) {
    profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    console.log(`Profile: cached (${profilePath})`);
  } else {
    console.log("Profile: reading the resume...");
    profile = await parseResume(resumeText);
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  }
  console.log(
    `  ${profile.name}: ${profile.totalYears} yrs in product (${profile.employedPmYears} employed PM, ${profile.founderYears} founder); ` +
      `archetypes ${profile.archetypes.map((a) => `${a.archetype}${a.strength === "primary" ? "*" : ""}`).join(", ")}; ML depth ${profile.mlDepth}`,
  );

  // 2. Provisional scores for every role.
  const roles = loadRoles();
  const cache = loadCache(CACHE_PATH);
  const analysisOf = (r: RoleRow): RoleAnalysis | null => {
    const a = cache[String(r.facts.id)];
    if (!a || a.contentHash !== r.contentHash) return null;
    // Backfilled text doesn't change content_hash (fetchDescriptions.ts), so
    // a title-only analysis is also stale once the posting's text arrives.
    if (!a.descriptionAvailable && cleanDescription(r.description).length > 200) return null;
    return a;
  };
  const provisional = roles
    .map((r) => ({ r, s: scoreRole(r.facts, profile, prefs, analysisOf(r)) }))
    .sort((a, b) => b.s.score - a.s.score);
  console.log(`Roles: ${roles.length} live; ${roles.filter((r) => analysisOf(r)).length} already analysed`);

  // 3. Analyse the most promising roles that aren't cached yet.
  const toAnalyze = provisional.slice(0, analyzeN).filter(({ r }) => !analysisOf(r)).map(({ r }) => r);
  if (toAnalyze.length > 0) {
    console.log(`Analysing ${toAnalyze.length} roles (one model call each, cached for every future resume)...`);
    let done = 0;
    let failed = 0;
    await mapLimit(toAnalyze, 8, async (r) => {
      try {
        cache[String(r.facts.id)] = await analyzeRole({
          id: r.facts.id,
          title: r.facts.title,
          company: r.facts.company,
          description: r.description,
          contentHash: r.contentHash,
        });
      } catch {
        failed++;
      }
      if (++done % 25 === 0) {
        saveCache(CACHE_PATH, cache);
        console.log(`  ${done}/${toAnalyze.length}`);
      }
    });
    saveCache(CACHE_PATH, cache);
    if (failed) console.log(`  ${failed} failed (left unanalysed; re-run to retry)`);
  }

  // 4. Re-score, then check requirements on the shortlist.
  let scored = roles.map((r) => ({ r, s: scoreRole(r.facts, profile, prefs, analysisOf(r)) })).sort((a, b) => b.s.score - a.s.score);
  // Title-only postings are skipped: there's nothing to check against.
  const shortlist = scored.slice(0, checkN).filter(({ r }) => analysisOf(r)?.descriptionAvailable);
  console.log(`Checking hard requirements for the top ${shortlist.length}...`);
  const checks = new Map<number, RequirementsCheck>();
  await mapLimit(shortlist, 8, async ({ r }) => {
    try {
      checks.set(r.facts.id, await checkRequirements(profile, { title: r.facts.title, company: r.facts.company, description: r.description }, analysisOf(r)!));
    } catch {
      /* unchecked roles keep their code-only requirements score */
    }
  });
  scored = roles
    .map((r) => ({ r, s: scoreRole(r.facts, profile, prefs, analysisOf(r), checks.get(r.facts.id) ?? null) }))
    .sort((a, b) => b.s.score - a.s.score);

  // 5. Report.
  writeReport(profile, prefs, scored);
}

function cell(s: string): string {
  return s.replace(/\|/g, "/").replace(/\n/g, " ");
}

function writeReport(profile: CandidateProfile, prefs: Preferences, all: Array<{ r: RoleRow; s: MatchScore }>) {
  // Only analysed roles are ranked: a provisional score is a guess used to
  // decide what to analyse, not a recommendation.
  const scored = all.filter(({ s }) => !s.provisional);
  const unanalysed = all.length - scored.length;
  // At most 3 per company in the top 25: Amazon alone posts hundreds of PM
  // roles, and a list that's all one employer isn't a useful shortlist.
  const perCompany = new Map<string, number>();
  const top = scored
    .filter(({ r }) => {
      const n = perCompany.get(r.facts.company) ?? 0;
      perCompany.set(r.facts.company, n + 1);
      return n < 3;
    })
    .slice(0, 25);
  // Roles to hand-score besides the top 25, spread evenly over everything
  // else analysed -- down to the Passes -- so the check covers what the
  // rubric rejects, not only what it likes.
  const rest = scored.filter((x) => !top.includes(x));
  const sample = Array.from({ length: Math.min(15, rest.length) }, (_, i) => rest[Math.floor((i * (rest.length - 1)) / Math.max(1, Math.min(15, rest.length) - 1))]);
  const tierCounts = scored.reduce<Record<string, number>>((acc, { s }) => ((acc[s.tier] = (acc[s.tier] ?? 0) + 1), acc), {});

  const lines: string[] = [];
  lines.push(`# Resume match test — ${profile.name}`, "");
  lines.push(`Generated ${new Date().toISOString()}. Rubric: Profile v2 (95 raw, scaled to 100), domain by archetype, engineering cap ${50}.`, "");
  lines.push("## Profile as read", "");
  lines.push(`- **Years in product:** ${profile.totalYears} (${profile.employedPmYears} employed PM, ${profile.founderYears} founder/head of product)`);
  lines.push(`- **Jobs:** ${profile.jobs.map((j) => `${j.title}, ${j.company} (${j.start}–${j.end ?? "present"})`).join("; ")}`);
  lines.push(`- **Archetypes:** ${profile.archetypes.map((a) => `${a.archetype} (${a.strength}) — "${a.evidence}"`).join("; ")}`);
  lines.push(`- **Domains:** ${profile.domains.join(", ")}`);
  lines.push(`- **ML depth:** ${profile.mlDepth} · **Managed people:** ${profile.managedPeople ? "yes" : "no"}`);
  lines.push(`- **Preferences:** pay floor $${prefs.payFloor / 1000}k, target $${prefs.payTarget / 1000}k; skip AI-first startups: ${prefs.skipAiFirstStartups ? "yes" : "no"}`, "");
  lines.push(`**Tiers across the ${scored.length} analysed roles** (${unanalysed} lower-ranked roles not analysed): ${["Strong Apply", "Apply", "Consider", "Pass"].map((t) => `${t} ${tierCounts[t] ?? 0}`).join(" · ")}`, "");

  const table = (rows: Array<{ r: RoleRow; s: MatchScore }>, startRank: (i: number) => number) => {
    lines.push(`| # | Score | Tier | Role | Company | ${CATEGORIES.map((c) => `${c.label.split(" ")[0]} /${c.max}`).join(" | ")} |`);
    lines.push(`|---|---|---|---|---|${CATEGORIES.map(() => "---").join("|")}|`);
    rows.forEach(({ r, s }, i) => {
      const pts = CATEGORIES.map((c) => String(s.categories.find((x) => x.id === c.id)!.points));
      lines.push(
        `| ${startRank(i)} | ${s.score}${s.capped ? "†" : ""}${s.provisional ? "?" : ""} | ${s.tier} | [${cell(r.facts.title)}](${r.facts.url ?? ""}) | ${cell(r.facts.company)} | ${pts.join(" | ")} |`,
      );
    });
    lines.push("", "† capped (engineering role or deep-ML requirement) · ? provisional (posting not analysed)", "");
  };

  lines.push("## Top 25 (at most 3 per company; # is the overall rank)", "");
  table(top, (i) => scored.indexOf(top[i]) + 1);
  lines.push("## Why — top 25", "");
  top.forEach(({ r, s }, i) => {
    lines.push(`**${i + 1}. ${r.facts.title} — ${r.facts.company}** (${s.score}, ${s.tier})${s.capped ? ` — capped: ${s.capped}` : ""}`);
    for (const c of s.categories) lines.push(`- ${CATEGORIES.find((x) => x.id === c.id)!.label} ${c.points}/${c.max}: ${c.evidence}`);
    lines.push("");
  });
  lines.push("## Calibration sample — spread across every other analysed role", "");
  table(sample, (i) => scored.indexOf(sample[i]) + 1);

  writeFileSync(path.join(LOCAL, "match-report.md"), lines.join("\n"));

  const csv = [
    ["rank", "role_id", "title", "company", "url", "our_score", "our_tier", "your_score", "your_tier", "notes"].join(","),
    ...[...top, ...sample].map(({ r, s }) =>
      [scored.findIndex((x) => x.r === r) + 1, r.facts.id, r.facts.title, r.facts.company, r.facts.url ?? "", s.score, s.tier, "", "", ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    ),
  ].join("\n");
  writeFileSync(path.join(LOCAL, "match-handscore.csv"), csv);

  console.log(`\nTiers (${scored.length} analysed roles): ${Object.entries(tierCounts).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
  console.log("Top 10:");
  top.slice(0, 10).forEach(({ r, s }) => console.log(`  ${String(scored.findIndex((x) => x.r === r) + 1).padStart(3)}. ${s.score} ${s.tier.padEnd(12)} ${r.facts.title} — ${r.facts.company}`));
  console.log(`\nReport: .local/match-report.md · Hand-score sheet: .local/match-handscore.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
