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
import { searchBambooHr } from "./sources/bamboohr.js";
import { searchWorkday } from "./sources/workday.js";
import { searchPaylocity } from "./sources/paylocity.js";
import { searchIcims } from "./sources/icims.js";
import { searchTikTok } from "./sources/tiktok.js";
import { searchApple } from "./sources/apple.js";
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

// `location` is included alongside title/description/salary so an adapter
// improvement that changes what location text a role reports (e.g.
// workday.ts's locationFromExternalPath fix) is picked up as a real change
// on the next sync instead of being silently invisible -- content_hash
// staying the same means updateRole never runs and the role's stale
// location/geocoding sits there forever. See updateRole below for the
// other half of this: a changed hash also needs to clear geocoded_at so
// geocode.ts actually re-resolves it rather than skipping an already-
// geocoded role.
function contentHash(job: RawJob): string {
  return createHash("sha256").update(`${job.title}\n${job.description}\n${job.salary}\n${job.location}`).digest("hex");
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
type Platform = "greenhouse" | "ashby" | "lever" | "bamboohr" | "workday" | "paylocity" | "icims" | "tiktok" | "apple";
const ALL_PLATFORMS: Platform[] = ["greenhouse", "ashby", "lever", "bamboohr", "workday", "paylocity", "icims", "tiktok", "apple"];

// Boards big enough that PER_BOARD_LIMIT would cut off real PM roles. TikTok
// is one company with ~4,300 postings worldwide, and the cap is applied
// before the PM filter, so 500 would keep an arbitrary eighth of them.
const PER_BOARD_LIMIT_OVERRIDES: Partial<Record<Platform, number>> = { tiktok: 10000 };

async function fetchPlatform(platform: Platform, boards: string[]): Promise<{ jobs: RawJob[]; meta: SearchMeta }> {
  const options = { boards, limit: PER_BOARD_LIMIT_OVERRIDES[platform] ?? PER_BOARD_LIMIT };
  switch (platform) {
    case "greenhouse":
      return searchGreenhouse("", options);
    case "ashby":
      return searchAshby("", options);
    case "lever":
      return searchLever("", options);
    case "bamboohr":
      return searchBambooHr("", options);
    case "workday":
      return searchWorkday("", options);
    case "paylocity":
      return searchPaylocity("", options);
    case "icims":
      return searchIcims("", options);
    case "tiktok":
      return searchTikTok("", options);
    case "apple":
      return searchApple("", options);
  }
}

async function main() {
  const db = getDb();

  const csvText = readFileSync(COMPANIES_CSV_PATH, "utf-8");
  const rows = parseCompaniesCsv(csvText).filter(
    (r) => r.status === "verified" && (ALL_PLATFORMS as string[]).includes(r.platform),
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
    const getCompanyBySource = db.prepare(
      `SELECT company_id AS id FROM company_sources WHERE platform = ? AND token = ?`,
    );
    const renameCompany = db.prepare(
      `UPDATE companies SET name = @name, slug = @slug, updated_at = datetime('now') WHERE id = @id`,
    );

    // Folds company `fromId` into `intoId`: its boards and roles move over,
    // then the emptied company row is deleted. A role that already exists
    // under `intoId` with the same source_job_id (the same posting listed on
    // two of the company's boards) can't move without breaking
    // UNIQUE(company_id, source_job_id), so UPDATE OR IGNORE leaves it
    // behind and the final DELETE's cascade drops that duplicate.
    const mergeCompany = db.transaction((fromId: number, intoId: number) => {
      db.prepare(`UPDATE OR IGNORE roles SET company_id = ? WHERE company_id = ?`).run(intoId, fromId);
      db.prepare(`UPDATE company_sources SET company_id = ? WHERE company_id = ?`).run(intoId, fromId);
      db.prepare(`UPDATE company_board_locations SET company_id = ? WHERE company_id = ?`).run(intoId, fromId);
      db.prepare(`DELETE FROM companies WHERE id = ?`).run(fromId);
    });

    /**
     * The company a board belongs to, looked up by the board itself
     * (company_sources) before falling back to the name's slug. Going by
     * slug alone meant renaming a company in companies.csv (e.g. fixing a
     * raw "Duckcreek|wd1|duckcreekcareers" display name) created a brand-new
     * company and orphaned the old one's roles as active forever, since
     * nothing ever checked or closed them again. Now a rename updates the
     * existing row in place, and renaming a board to a company that already
     * exists under another board merges the two.
     */
    function resolveCompanyId(platform: string, board: string, name: string, slug: string): number {
      const bySource = getCompanyBySource.get(platform, board) as { id: number } | undefined;
      const bySlug = getCompanyBySlug.get(slug) as { id: number } | undefined;
      if (bySource) {
        if (bySlug && bySlug.id !== bySource.id) {
          mergeCompany(bySource.id, bySlug.id);
          return bySlug.id;
        }
        if (!bySlug) renameCompany.run({ id: bySource.id, name, slug });
        return bySource.id;
      }
      return bySlug ? bySlug.id : (upsertCompany.get({ name, slug }) as { id: number }).id;
    }

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
    // Resets geocoded_at/resolved_city/resolved_state/latitude/longitude to
    // NULL whenever content_hash actually changed -- that's the ONLY thing
    // that makes geocode.ts (which only looks at roles WHERE geocoded_at IS
    // NULL) re-resolve a role whose location text changed since the last
    // sync, rather than leaving it pointed at a now-stale city forever. The
    // role's role_locations rows are separately cleared and rebuilt by
    // geocode.ts itself once it reprocesses the role.
    const updateRole = db.prepare(`
      UPDATE roles SET
        title = @title, description = @description, location = @location,
        salary_min = @salaryMin, salary_max = @salaryMax, salary_currency = @salaryCurrency,
        category = @category, url = @url, posted_at = @postedAt,
        content_hash = @contentHash, last_seen_at = datetime('now'), status = 'active',
        geocoded_at = NULL, resolved_city = NULL, resolved_state = NULL, latitude = NULL, longitude = NULL
      WHERE id = @id
    `);
    const closeStaleRoles = db.prepare(`
      UPDATE roles SET status = 'closed'
      WHERE company_id = ? AND status = 'active' AND last_seen_at < datetime('now', '-1 day')
    `);

    // Replaced wholesale per company on every sync -- see schema.sql's
    // comment on company_board_locations for why this isn't incremental.
    const deleteBoardLocations = db.prepare(`DELETE FROM company_board_locations WHERE company_id = ?`);
    const insertBoardLocation = db.prepare(`
      INSERT INTO company_board_locations (company_id, raw_location, posting_count)
      VALUES (?, ?, ?)
    `);

    const seenCompanySlugs = new Set<string>();

    for (const [platform, platformRows] of byPlatform) {
      const boards = platformRows.map((r) => r.token);
      const nameByToken = new Map(platformRows.map((r) => [r.token, r.company]));

      const { jobs: allJobs, meta } = await fetchPlatform(platform as Platform, boards);
      const jobs = allJobs.filter((job) => matchesProductManagerFilter(job.title));
      // "checked" = boards that actually returned data, whether or not that
      // data included any postings. "failed" is now only boards whose fetch
      // genuinely couldn't complete (timeout even after retry, network
      // error, non-2xx response) -- a board that loaded fine with zero
      // current postings shows up in boardsEmpty instead, so a dead token
      // doesn't get lost in the noise of real companies with nothing open.
      console.log(
        `[${platform}] checked ${meta.boardsChecked.length} boards (${meta.boardsEmpty.length} empty), ${meta.boardsFailed.length} failed, ${allJobs.length} total postings, ${jobs.length} classified as PM`,
      );
      // Boards down for the vendor's scheduled maintenance are still in
      // boardsFailed (so their roles are left untouched, same as any other
      // failure), but get their own line so a weekend maintenance window
      // doesn't read as a pile of dead tokens.
      const inMaintenance = new Set(meta.boardsInMaintenance ?? []);
      const otherFailed = meta.boardsFailed.filter((b) => !inMaintenance.has(b));
      if (inMaintenance.size > 0) {
        console.log(
          `[${platform}] ${inMaintenance.size} boards down for scheduled vendor maintenance (temporary, retry later): ${[...inMaintenance].join(", ")}`,
        );
      }
      if (otherFailed.length > 0) {
        console.log(`[${platform}] failed boards: ${otherFailed.join(", ")}`);
      }
      if (meta.boardsEmpty.length > 0) {
        console.log(`[${platform}] empty boards (loaded fine, 0 postings): ${meta.boardsEmpty.join(", ")}`);
      }

      const jobsByBoard = new Map<string, RawJob[]>();
      for (const job of jobs) {
        const list = jobsByBoard.get(job.board) ?? [];
        list.push(job);
        jobsByBoard.set(job.board, list);
      }

      // Same grouping, but over allJobs (every department, unfiltered) --
      // this feeds geocode.ts's board-wide dominant-office fallback so a
      // company with no resolved PM office can still be pinned from its
      // other postings' real locations instead of vanishing off the map.
      const allJobsByBoard = new Map<string, RawJob[]>();
      for (const job of allJobs) {
        const list = allJobsByBoard.get(job.board) ?? [];
        list.push(job);
        allJobsByBoard.set(job.board, list);
      }

      for (const board of meta.boardsChecked) {
        const companyName = nameByToken.get(board) ?? board;
        const slug = slugify(companyName);

        const companyId = resolveCompanyId(platform, board, companyName, slug);

        upsertSource.run({ companyId, platform, token: board });
        const firstBoardForCompany = !seenCompanySlugs.has(slug);
        if (firstBoardForCompany) {
          seenCompanySlugs.add(slug);
          companiesSynced += 1;
        }

        // Tally raw location strings across the company's FULL board (all
        // departments, from allJobsByBoard) -- not just its PM postings --
        // and replace this company's company_board_locations rows with the
        // fresh count. See schema.sql for why geocode.ts wants this. Only
        // cleared on the company's FIRST board this run -- a company with
        // several boards (Peak6, Duck Creek) would otherwise have each
        // board wipe the locations the previous one just wrote.
        const boardAllJobs = allJobsByBoard.get(board) ?? [];
        const locationTally = new Map<string, number>();
        for (const job of boardAllJobs) {
          const loc = job.location?.trim();
          if (!loc) continue;
          locationTally.set(loc, (locationTally.get(loc) ?? 0) + 1);
        }
        if (firstBoardForCompany) deleteBoardLocations.run(companyId);
        for (const [rawLocation, count] of locationTally) {
          insertBoardLocation.run(companyId, rawLocation, count);
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
