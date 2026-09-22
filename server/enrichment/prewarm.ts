/**
 * enrichment/prewarm.ts
 * Fills the company intelligence cache on a schedule instead of when
 * someone opens a role page.
 *
 * Before this existed, enrichment was purely lazy: loadIntelligence ran
 * only for the one company whose role page you opened. That left the
 * dossier blank on first view for almost every company on the map (13 of
 * 587 had a profile cached), and made opening a role page wait on live
 * requests to Wikidata, Clearbit, EDGAR and Google News.
 *
 * Running the same code path from the nightly workflow means the static
 * export (server/export/companyDetails.ts, which reads the cache and never
 * fetches) bakes real dossiers into public/data/companies/*.json -- so the
 * role page renders complete with no API call at all, and the /api
 * endpoint becomes a fallback for gaps rather than the main path.
 *
 * Budgeted on purpose. Wikidata's access policy asks callers to make
 * sequential requests and "space companies out" (see wikidata.ts), so this
 * walks one company at a time with a pause between them, and stops when it
 * runs out of its time budget rather than trying to finish in one pass.
 * Whatever it doesn't reach today is simply first in line tomorrow, since
 * companies are ordered by how stale their cache is.
 *
 * Usage: npm run prewarm -- [--minutes=25] [--companies=N] [--focus=150] [--delay=500] [--concurrency=1]
 */

import { getDb } from "../db/client.js";
import { loadIntelligence } from "./intelligence.js";

interface Options {
  timeBudgetMs: number;
  maxCompanies: number;
  focusLimit: number;
  delayMs: number;
  concurrency: number;
}

function parseOptions(argv: string[]): Options {
  const flag = (name: string, fallback: number) => {
    const raw = argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    // Long enough to make real progress in a GitHub Actions run, short
    // enough that a hung source can't hold the daily workflow open.
    timeBudgetMs: flag("minutes", 25) * 60_000,
    maxCompanies: flag("companies", Number.POSITIVE_INFINITY),
    // Role focus is per-role and there are thousands; a slice per run
    // covers the backlog over a few days and then only tracks changes,
    // since a cached summary is reused until the role's content_hash moves.
    focusLimit: flag("focus", 150),
    delayMs: flag("delay", 500),
    // 1 by default: Wikidata asks for sequential requests. Raise it only
    // for a one-off local backfill.
    concurrency: Math.max(1, flag("concurrency", 1)),
  };
}

interface CompanyRow {
  id: number;
  slug: string;
  name: string;
  fresh_kinds: number;
  role_count: number;
}

/**
 * Companies whose cache is missing or stale, emptiest first. A company
 * counts as done only when BOTH 'profile' and 'news' are present and
 * unexpired -- checking the oldest refresh_after instead would skip a
 * company whose news fetch failed but whose profile is still fresh.
 */
function companiesNeedingWork(db: ReturnType<typeof getDb>): CompanyRow[] {
  return db
    .prepare(
      `SELECT c.id, c.slug, c.name,
              (SELECT COUNT(*) FROM company_enrichments e
                WHERE e.company_id = c.id AND e.kind IN ('profile', 'news')
                  AND (e.refresh_after IS NULL OR e.refresh_after > datetime('now'))) AS fresh_kinds,
              COUNT(r.id) AS role_count
       FROM companies c
       JOIN roles r ON r.company_id = c.id AND r.status = 'active'
       GROUP BY c.id
       HAVING fresh_kinds < 2
       ORDER BY fresh_kinds ASC, role_count DESC, c.id ASC`,
    )
    .all() as CompanyRow[];
}

interface FocusRow {
  id: number;
  slug: string;
  title: string;
}

/**
 * Active roles with no cached focus summary, or one written against an
 * older version of the posting. Newest first -- a role someone is likely
 * to open is one that just appeared.
 */
function rolesNeedingFocus(db: ReturnType<typeof getDb>, limit: number): FocusRow[] {
  if (limit <= 0) return [];
  return db
    .prepare(
      `SELECT r.id, c.slug, r.title
       FROM roles r
       JOIN companies c ON c.id = r.company_id
       LEFT JOIN role_enrichments e ON e.role_id = r.id AND e.kind = 'focus_summary'
       WHERE r.status = 'active'
         AND (e.id IS NULL OR json_extract(e.data, '$.contentHash') IS NOT r.content_hash)
         AND EXISTS (SELECT 1 FROM company_sources s WHERE s.company_id = r.company_id AND s.platform = r.platform)
       ORDER BY r.first_seen_at DESC
       LIMIT ?`,
    )
    .all(limit) as FocusRow[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const db = getDb();
  const deadline = Date.now() + options.timeBudgetMs;

  const companies = companiesNeedingWork(db).slice(0, options.maxCompanies);
  console.log(
    `Pre-warm: ${companies.length} companies need company intelligence ` +
      `(budget ${Math.round(options.timeBudgetMs / 60_000)}m, concurrency ${options.concurrency})`,
  );

  let done = 0;
  let failed = 0;
  let unavailable = 0;
  let ranOutOfTime = false;

  // A worker pool that's a plain loop at the default concurrency of 1.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (Date.now() > deadline) {
        ranOutOfTime = true;
        return;
      }
      const company = companies[cursor++];
      if (!company) return;
      try {
        const result = await loadIntelligence(db, company.slug, null);
        // A source that couldn't be reached caches nothing, so the company
        // stays at the front of tomorrow's queue -- worth counting, but
        // not an error.
        if (result && result.unavailable.length > 0) unavailable += 1;
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn(`  ! ${company.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (done % 25 === 0 && done > 0) {
        console.log(`  ${done}/${companies.length} companies (${Math.round((deadline - Date.now()) / 60_000)}m left)`);
      }
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));

  // Whatever budget is left goes to role focus summaries.
  const focusRoles = Date.now() < deadline ? rolesNeedingFocus(db, options.focusLimit) : [];
  let focusDone = 0;
  let focusFailed = 0;
  if (focusRoles.length > 0) {
    console.log(`Pre-warm: ${focusRoles.length} role focus summaries queued`);
    for (const role of focusRoles) {
      if (Date.now() > deadline) {
        ranOutOfTime = true;
        break;
      }
      try {
        // The company half is a cache hit by now; this is here for the
        // role's own focus bullets.
        await loadIntelligence(db, role.slug, role.id);
        focusDone += 1;
      } catch (err) {
        focusFailed += 1;
        console.warn(`  ! focus for "${role.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }

  const remaining = Math.max(0, companies.length - cursor);
  console.log(
    `Pre-warm complete: ${done} companies (${unavailable} with a source unavailable, ${failed} failed), ` +
      `${focusDone} role summaries (${focusFailed} failed)` +
      (ranOutOfTime ? ` -- stopped on the time budget, ${remaining} companies left for next run` : ""),
  );

  // Never fails the daily workflow: a half-filled cache is strictly better
  // than none, and the export that follows reads whatever is there. Only a
  // run that accomplished nothing at all is worth a non-zero exit.
  if (done === 0 && focusDone === 0 && (failed > 0 || focusFailed > 0)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Pre-warm failed:", err);
  process.exitCode = 1;
});
