/**
 * scripts/fix-raw-company-names.ts
 * One-off repair for display names in data/companies.csv that are really
 * raw board tokens -- "Duckcreek|wd1|duckcreekcareers" (discoverCompanies.ts
 * used to title-case whole Workday tokens) or "P-1%20AI" (a URL-encoded
 * token). Workday rows get the board's real hiringOrganization name via
 * fetchWorkdayCompanyName; anything else is just percent-decoded.
 *
 * Only rewrites the affected lines; every other line of the CSV is left
 * byte-for-byte alone. Re-runnable: a Workday board that can't be read
 * right now (e.g. during Workday's weekend maintenance on wd1/wd3/wd5) is
 * skipped and reported, and still looks raw next time.
 *
 * The database side needs nothing here -- sync.ts resolves a board's
 * company by the board itself, so the next `npm run sync` renames the
 * existing company (or merges it into another board's company of the same
 * name) instead of creating a duplicate.
 *
 * Usage: npx tsx scripts/fix-raw-company-names.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseCompaniesCsv } from "../server/ingestion/csv.js";
import { fetchWorkdayCompanyName } from "../server/ingestion/sources/workday.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANIES_CSV_PATH = path.join(__dirname, "..", "data", "companies.csv");

function looksRaw(name: string): boolean {
  return name.includes("|") || /%[0-9A-F]{2}/i.test(name);
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main() {
  const text = readFileSync(COMPANIES_CSV_PATH, "utf-8");
  const lines = text.split("\n");
  const header = lines[0].replace(/\r$/, "");

  let fixed = 0;
  const skipped: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const eol = raw.endsWith("\r") ? "\r" : "";
    const line = raw.slice(0, raw.length - eol.length);
    if (!line) continue;
    const [row] = parseCompaniesCsv(`${header}\n${line}`);
    if (!row || !looksRaw(row.company)) continue;

    let newName: string | null;
    if (row.platform === "workday") {
      newName = await fetchWorkdayCompanyName(row.token);
    } else {
      try {
        newName = decodeURIComponent(row.company);
      } catch {
        newName = null;
      }
    }
    if (!newName || looksRaw(newName)) {
      skipped.push(`${row.company} (${row.platform}:${row.token})`);
      continue;
    }

    const fields = [row.company, row.token, row.platform, row.status, row.last_checked, row.notes];
    fields[0] = newName;
    lines[i] = fields.map(csvField).join(",") + eol;
    console.log(`  ${row.company}  ->  ${newName}`);
    fixed += 1;
  }

  if (fixed > 0) writeFileSync(COMPANIES_CSV_PATH, lines.join("\n"));
  console.log(`\nFixed ${fixed} names.`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} (board unreadable right now -- re-run later):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (fixed > 0) console.log("Run npm run sync && npm run geocode && npm run export to carry the new names through.");
}

main().catch((err) => {
  console.error("Name fix failed:", err);
  process.exitCode = 1;
});
