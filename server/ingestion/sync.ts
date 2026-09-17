/**
 * ingestion/sync.ts
 * Daily ingestion entry point. Loads verified companies from
 * data/companies.csv, fetches current postings per ATS platform, filters to
 * Product Manager roles, and upserts everything into SQLite with
 * content-hash diffing so a re-sync can tell "this posting changed" from
 * "still the same, still open."
 *
 * Usage: npm run sync
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDb } from "../db/client.js";
import { parseCompaniesCsv, type CompanyRow } from "./csv.js";
import { searchGreenhouse } from "./sources/greenhouse.js";
import { searchAshby } from "./sources/ashby.js";
import { searchLever } from "./sources/lever.js";
import { matchesProductManagerFilter } from "./filters/productManager.js";
import type { RawJob, SearchMeta } from "./sources/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "..", "data", "companies.csv");

// Per-board result cap. This now caps the UNFILTERED fetch (see
// fetchPlatform below) — boards are per-company, so even a generous cap
// like this just bounds a pathological case (a board with thousands of
// postings) from dominating one sync run; it's not the PM filter.
const PER_BOARD_LIMIT = 500;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function contentHash(job: RawJob): string {
  return createHash("sha256").update(`${job.title}\n${job.description}\n${job.salary}`).digest("hex");
}

function parseSalary(salary: string): { min: number | null; max: number | null; currency: string | null } {
  // salary strings look like "USD 120,000 - 150,000" or "USD 150,000" or "".
  if (!salary) return { min: null, max: null, currency: null };
  const currencyMatch = salary.match(/^([A-Z]{3}|US\$|\$)/);
  const currency = currencyMatch ? currencyMatch[0].replace("US$", "USD").replace("$", "USD") : null;
  const numbers = salary.match(/\d[\d,]*/g)?.map((n) => Number(n.replace(/,/g, ""))) ?? [];
  if (numbers.length >= 2) return { min: numbers[0], max: numbers[1], currency };
  if (numbers.length === 1) return { min: numbers[0], max: numbers[0], currency };
  return { min: null, max: null, currency };
}

/**
 * Fetches EVERY posting from each board, unfiltered — no title include/
 * exclude passed to the adapter at all. PM classification happens
 * afterward via matchesProductManagerFilter, so tuning that function
 * changes what the next sync stores without touching these adapters.
 */
async function fetchPlatform(
  platform: "greenhouse" | "ashby" | "lever",
  boards: string[],
): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  const options = { boards, limit: PER_BOARD_LIMIT };
  switch (platform) {
    case "greenhouse":
      return searchGreenhouse("", options);
    case "ashby":
      return searchAshby("", options);
    case "lever":
      return searchLever("", options);
  }
}

async function main() {
  const db = getDb();

  const csvText = readFileSync(COMPANIES_CSV_PATH, "utf-8");
  const rows = parseCompaniesCsv(csvText).filter(
    (r) => r.status === "verified" && ["greenhouse", "ashby", "lever"].includes(r.platform),
  );

  const byPlatform = new Map<string, CompanyRow[]>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }

  const runStmt = db.prepare(
    `INSERT INTO sync_runs (status) VALUES ('running')`,
  );
  const runId = runStmt.run().lastInsertRowid as number;

  let companiesSynced = 0;
  let rolesInserted = 0;
  let rolesUpdated = 0;
  let rolesClosed = 0;
  let runError: string | null = null;

  try {
    const upsertCompany = db.prepare(`
      INSERT INTO companies (name, slug)
      VALUES (@name, @slug)
      ON CONFLICT (slug) DO UPDATE SET updated_at = datetime('now')
      RETURNING id
    `);
    const getCompanyBySlug = db.prepare(`SELECT id FROM companies WHERE slug = ?`);

    const upsertSource = db.prepare(`
      INSERT INTO company_sources (company_id, platform, token, status, last_checked)
      VALUES (@companyId, @platform, @token, 'verified', datetime('now'))
      ON CONFLICT (platform, token) DO UPDATE SET status = 'verified', last_checked = datetime('now')
    `);

    const getRole = db.prepare(`
      SELECT id, content_hash, status FROM roles WHERE company_id = ? AND source_job_id = ?
    `);
    const insertRole = db.prepare(`
      INSERT INTO roles (
        company_id, source_job_id, platform, title, description, location,
        salary_min, salary_max, salary_currency, category, url, posted_at,
        content_hash, status
      ) VALUES (
        @companyId, @sourceJobId, @platform, @title, @description, @location,
        @salaryMin, @salaryMax, @salaryCurrency, @category, @url, @postedAt,
        @contentHash, 'active'
      )
    `);
    const touchRole = db.prepare(`
      UPDATE roles SET last_seen_at = datetime('now'), status = 'active' WHERE id = ?
    `);
    const updateRole = db.prepare(`
      UPDATE roles SET
        title = @title, description = @description, location = @location,
        salary_min = @salaryMin, salary_max = @salaryMax, salary_currency = @salaryCurrency,
        category = @category, url = @url, posted_at = @postedAt,
        content_hash = @contentHash, last_seen_at = datetime('now'), status = 'active'
      WHERE id = @id
    `);
    const closeStaleRoles = db.prepare(`
      UPDATE roles SET status = 'closed'
      WHERE company_id = ? AND status = 'active' AND last_seen_at < datetime('now', '-1 day')
    `);

    const seenCompanySlugs = new Set<string>();

    for (const [platform, platformRows] of byPlatform) {
      const boards = platformRows.map((r) => r.token);
      const nameByToken = new Map(platformRows.map((r) => [r.token, r.company]));

      const { jobs: allJobs, meta } = await fetchPlatform(platform as "greenhouse" | "ashby" | "lever", boards);
      const jobs = allJobs.filter((job) => matchesProductManagerFilter(job.title));
      console.log(
        `[${platform}] checked ${meta.boardsChecked.length} boards, ${meta.boardsFailed.length} failed, ${allJobs.length} total postings, ${jobs.length} classified as PM`,
      );
      if (meta.boardsFailed.length > 0) {
        console.log(`[${platform}] failed boards: ${meta.boardsFailed.join(", ")}`);
      }

      const jobsByBoard = new Map<string, RawJob[]>();
      for (const job of jobs) {
        const list = jobsByBoard.get(job.board) ?? [];
        list.push(job);
        jobsByBoard.set(job.board, list);
      }

      for (const board of meta.boardsChecked) {
        const companyName = nameByToken.get(board) ?? board;
        const slug = slugify(companyName);

        const existing = getCompanyBySlug.get(slug) as { id: number } | undefined;
        const companyId = existing
          ? existing.id
          : (upsertCompany.get({ name: companyName, slug }) as { id: number }).id;

        upsertSource.run({ companyId, platform, token: board });
        if (!seenCompanySlugs.has(slug)) {
          seenCompanySlugs.add(slug);
          companiesSynced += 1;
        }

        const boardJobs = jobsByBoard.get(board) ?? [];
        for (const job of boardJobs) {
          const hash = contentHash(job);
          const { min, max, currency } = parseSalary(job.salary);
          const existingRole = getRole.get(companyId, job.id) as
            | { id: number; content_hash: string; status: string }
            | undefined;

          if (!existingRole) {
            insertRole.run({
              companyId,
              sourceJobId: job.id,
              platform,
              title: job.title,
              description: job.description,
              location: job.location,
              salaryMin: min,
              salaryMax: max,
              salaryCurrency: currency,
              category: job.category,
              url: job.url,
              postedAt: job.published || null,
              contentHash: hash,
            });
            rolesInserted += 1;
          } else if (existingRole.content_hash !== hash) {
            updateRole.run({
              id: existingRole.id,
              title: job.title,
              description: job.description,
              location: job.location,
              salaryMin: min,
              salaryMax: max,
              salaryCurrency: currency,
              category: job.category,
              url: job.url,
              postedAt: job.published || null,
              contentHash: hash,
            });
            rolesUpdated += 1;
          } else {
            touchRole.run(existingRole.id);
          }
        }

        const closeResult = closeStaleRoles.run(companyId);
        rolesClosed += closeResult.changes;
      }
    }

    db.prepare(
      `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'),
       companies_synced = ?, roles_inserted = ?, roles_updated = ?, roles_closed = ? WHERE id = ?`,
    ).run(companiesSynced, rolesInserted, rolesUpdated, rolesClosed, runId);
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'),
       companies_synced = ?, roles_inserted = ?, roles_updated = ?, roles_closed = ?, error = ? WHERE id = ?`,
    ).run(companiesSynced, rolesInserted, rolesUpdated, rolesClosed, runError, runId);
    throw err;
  }

  console.log(
    `Sync run #${runId} complete: ${companiesSynced} companies, ${rolesInserted} inserted, ${rolesUpdated} updated, ${rolesClosed} closed`,
  );
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exitCode = 1;
});
