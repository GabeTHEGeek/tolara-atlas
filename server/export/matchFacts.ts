/**
 * export/matchFacts.ts
 * public/data/match-facts.json: what the browser needs to score a visitor
 * against every analysed role -- the quiz-based match on the public site
 * (src/quizMatch.ts). Each entry is the role's facts (level, band, offices,
 * company size) and its cached analysis from data/role-analysis.json.
 *
 * Nothing personal: the analysis describes the posting, not any candidate,
 * and is the same for everyone. No model calls here either -- roles get
 * analysed when scripts/match-resume.ts runs (or scripts/analyze-roles.ts),
 * and an analysis is shipped only while it still matches the posting:
 * same content_hash, and not a title-only read of a posting whose text has
 * since arrived. Unanalysed roles simply get no score, as on the owner's
 * machine: a provisional score is a guess, not a recommendation.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { readCachedIntelligence } from "../enrichment/intelligence.js";
import { cleanDescription, type RoleAnalysis } from "../match/analyzeRole.js";
import type { RoleFacts } from "../match/score.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANALYSIS_PATH = path.join(ROOT, "data", "role-analysis.json");

// Just the fields read here, so both the export's own row types and the
// browser's MapData fit.
interface RoleLike {
  id: number;
  title: string;
  seniority: RoleFacts["seniority"];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  isRemote: boolean;
}
interface CompanyLike {
  companyId: number;
  companyName: string;
  companySlug: string;
  roles: RoleLike[];
}

export type ShippedAnalysis = Omit<RoleAnalysis, "contentHash" | "analyzedAt">;

export interface MatchFactsFile {
  generatedAt: string;
  roles: Array<{ facts: RoleFacts; analysis: ShippedAnalysis }>;
}

export function writeMatchFacts(
  db: Database.Database,
  pins: Array<CompanyLike & { city: string | null; state: string | null }>,
  remoteCompanies: CompanyLike[],
  outPath: string,
): number {
  const cache: Record<string, RoleAnalysis> = existsSync(ANALYSIS_PATH) ? JSON.parse(readFileSync(ANALYSIS_PATH, "utf-8")) : {};
  const dbRows = new Map(
    (db.prepare(`SELECT id, description, content_hash FROM roles WHERE status = 'active'`).all() as Array<{
      id: number;
      description: string | null;
      content_hash: string;
    }>).map((r) => [r.id, r]),
  );
  const employees = new Map<number, number | null>();
  const employeesOf = (companyId: number) => {
    if (!employees.has(companyId)) employees.set(companyId, readCachedIntelligence(db, companyId, null)?.profile?.employees ?? null);
    return employees.get(companyId) ?? null;
  };

  const byId = new Map<number, { facts: RoleFacts; analysis: ShippedAnalysis }>();
  const add = (role: RoleLike, companyId: number, company: string, slug: string, city: string | null) => {
    let entry = byId.get(role.id);
    if (!entry) {
      const a = cache[String(role.id)];
      const row = dbRows.get(role.id);
      if (!a || !row || a.contentHash !== row.content_hash) return;
      if (!a.descriptionAvailable && cleanDescription(row.description).length > 200) return;
      const { contentHash: _h, analyzedAt: _t, ...analysis } = a;
      entry = {
        facts: {
          id: role.id,
          title: role.title.trim(),
          company,
          companySlug: slug,
          url: null, // the browser has the posting link already, from map-data.json
          seniority: role.seniority,
          salaryMin: role.salaryMin,
          salaryMax: role.salaryMax,
          salaryCurrency: role.salaryCurrency,
          salaryPeriod: role.salaryPeriod,
          isRemote: false,
          cities: [],
          employees: employeesOf(companyId),
        },
        analysis,
      };
      byId.set(role.id, entry);
    }
    if (role.isRemote || !city) entry.facts.isRemote = true;
    else if (!entry.facts.cities.includes(city)) entry.facts.cities.push(city);
  };
  for (const pin of pins) {
    const city = pin.city ? (pin.state ? `${pin.city}, ${pin.state}` : pin.city) : null;
    for (const role of pin.roles) add(role, pin.companyId, pin.companyName, pin.companySlug, city);
  }
  for (const c of remoteCompanies) for (const role of c.roles) add(role, c.companyId, c.companyName, c.companySlug, null);

  const file: MatchFactsFile = { generatedAt: new Date().toISOString(), roles: [...byId.values()] };
  writeFileSync(outPath, JSON.stringify(file));
  return file.roles.length;
}
