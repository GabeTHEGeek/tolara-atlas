/**
 * scripts/check-companies.ts
 * Checks data/companies.csv before a sync reads it, so a hand edit or a bad
 * discovery row fails loudly here instead of quietly breaking a board or a
 * company page. Run with `npm run check:companies`; the nightly workflow
 * runs it before `npm run sync`.
 *
 * Errors (exit code 1):
 *  - the header isn't the expected one
 *  - a row doesn't have exactly six fields (an unquoted comma in a name)
 *  - a row is missing its company, token or platform
 *  - a platform the sync has no reader for
 *  - the same board (platform + token) listed twice
 *  - two different names that make the same page address (slug), so one
 *    company's roles would show on the other's page
 *  - a CRLF line ending (.gitattributes keeps the file LF)
 * Warnings: names with spaces at either end.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANIES_CSV_HEADER, parseLine, SUPPORTED_PLATFORMS } from "../server/ingestion/csv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, "..", "data", "companies.csv");

// The same rule sync.ts uses to turn a company name into its page address.
const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const STATUSES = new Set(["verified", "unverified", "failed"]);

const text = readFileSync(CSV_PATH, "utf8");
const lines = text.split("\n");
const errors: string[] = [];
const warnings: string[] = [];

if (lines[0].replace(/\r$/, "") !== COMPANIES_CSV_HEADER) {
  errors.push(`line 1: header should be "${COMPANIES_CSV_HEADER}"`);
}

const boards = new Map<string, number>(); // "platform|token" -> line
const slugs = new Map<string, { name: string; line: number }>();
let rows = 0;

for (let i = 1; i < lines.length; i++) {
  const n = i + 1;
  let line = lines[i];
  if (line.endsWith("\r")) {
    errors.push(`line ${n}: CRLF line ending`);
    line = line.slice(0, -1);
  }
  if (line === "") continue;
  rows++;
  const fields = parseLine(line);
  if (fields.length !== 6) {
    errors.push(`line ${n}: ${fields.length} fields, expected 6 (a comma in a name needs quotes): ${line}`);
    continue;
  }
  const [company, token, platform, status] = fields;
  if (!company.trim() || !token.trim() || !platform.trim()) {
    errors.push(`line ${n}: missing company, token or platform: ${line}`);
    continue;
  }
  if (company !== company.trim()) warnings.push(`line ${n}: spaces around the name "${company}"`);
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    errors.push(`line ${n}: unknown platform "${platform}" for ${company}`);
  }
  if (!STATUSES.has(status)) errors.push(`line ${n}: unknown status "${status}" for ${company}`);

  const board = `${platform}|${token.toLowerCase()}`;
  const seen = boards.get(board);
  if (seen) errors.push(`line ${n}: ${company} repeats the ${platform} board "${token}" from line ${seen}`);
  else boards.set(board, n);

  // One company on several boards (same name) is fine; two names on one
  // address is not.
  const slug = slugify(company);
  if (!slug) {
    errors.push(`line ${n}: "${company}" has no letters or digits to make a page address from`);
    continue;
  }
  const other = slugs.get(slug);
  if (other && other.name.trim() !== company.trim()) {
    errors.push(`line ${n}: "${company}" and "${other.name}" (line ${other.line}) would share the page /companies/${slug}/`);
  } else if (!other) {
    slugs.set(slug, { name: company, line: n });
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\ncompanies.csv: ${errors.length} problem${errors.length === 1 ? "" : "s"} in ${rows} rows.`);
  process.exit(1);
}
console.log(`companies.csv OK: ${rows} boards, ${slugs.size} companies.`);
