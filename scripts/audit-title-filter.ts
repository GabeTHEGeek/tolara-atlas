/**
 * scripts/audit-title-filter.ts
 * Diagnostic: fetches ALL postings (no title filtering at all) from every
 * verified board, then reports every title containing "product" that the
 * current PM_TITLE_INCLUDE/EXCLUDE filter would currently DROP. Lets us
 * see real missed titles instead of guessing at edge cases.
 *
 * This does NOT touch the database — read-only, prints to console.
 * Usage: npx tsx scripts/audit-title-filter.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseCompaniesCsv, type CompanyRow } from "../server/ingestion/csv.js";
import { searchGreenhouse } from "../server/ingestion/sources/greenhouse.js";
import { searchAshby } from "../server/ingestion/sources/ashby.js";
import { searchLever } from "../server/ingestion/sources/lever.js";
import { matchesProductManagerFilter } from "../server/ingestion/filters/productManager.js";
import type { RawJob } from "../server/ingestion/sources/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "data", "companies.csv");

async function fetchAllUnfiltered(
  platform: "greenhouse" | "ashby" | "lever",
  boards: string[],
): Promise<RawJob[]> {
  const options = { boards, limit: 300 }; // no requireTitleKeywords/excludeTitles: everything comes through
  switch (platform) {
    case "greenhouse":
      return (await searchGreenhouse("", options)).jobs;
    case "ashby":
      return (await searchAshby("", options)).jobs;
    case "lever":
      return (await searchLever("", options)).jobs;
  }
}

async function main() {
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

  let totalJobs = 0;
  let totalContainingProduct = 0;
  const missed: Array<{ company: string; title: string }> = [];

  for (const [platform, platformRows] of byPlatform) {
    const boards = platformRows.map((r) => r.token);
    const nameByToken = new Map(platformRows.map((r) => [r.token, r.company]));
    console.log(`Fetching ALL postings from ${boards.length} ${platform} boards (unfiltered)...`);
    const jobs = await fetchAllUnfiltered(platform as "greenhouse" | "ashby" | "lever", boards);
    totalJobs += jobs.length;

    for (const job of jobs) {
      if (!job.title.toLowerCase().includes("product")) continue;
      totalContainingProduct += 1;
      if (!matchesProductManagerFilter(job.title)) {
        missed.push({ company: nameByToken.get(job.board) ?? job.board, title: job.title });
      }
    }
  }

  console.log(`\nTotal postings fetched (all titles, all companies): ${totalJobs}`);
  console.log(`Postings with "product" anywhere in the title: ${totalContainingProduct}`);
  console.log(`Of those, titles the CURRENT filter would drop: ${missed.length}\n`);
  for (const m of missed) {
    console.log(`  MISSED: [${m.company}] "${m.title}"`);
  }
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exitCode = 1;
});
