/**
 * ingestion/csv.ts
 * Reads and writes rows of data/companies.csv, the list of boards the sync
 * checks. No external dependency. A field with a comma, quote or line break
 * is wrapped in quotes ("Computer Services, Inc."), and every script that
 * adds rows goes through formatCompanyRow so they all quote the same way.
 * The file uses LF line endings (.gitattributes), and
 * scripts/check-companies.ts checks it before each nightly sync.
 */

/** Every platform sync.ts has a reader for, in the order it syncs them. */
export const SUPPORTED_PLATFORMS = [
  "greenhouse",
  "ashby",
  "lever",
  "bamboohr",
  "workday",
  "paylocity",
  "icims",
  "tiktok",
  "apple",
  "meta",
  "eightfold",
  "atlassian",
  "amazon",
  "microsoft",
  "booking",
  "smartrecruiters",
  "oracle",
  "google",
] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

export const COMPANIES_CSV_HEADER = "company,token,platform,status,last_checked,notes";

export interface CompanyRow {
  company: string;
  token: string;
  platform: Platform | string;
  status: "verified" | "unverified" | "failed" | string;
  last_checked: string;
  notes: string;
}

/** Quotes a field only when it has to be: a comma, quote or line break in it. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One companies.csv line, newline included, ready to append. */
export function formatCompanyRow(row: CompanyRow): string {
  return [row.company, row.token, row.platform, row.status, row.last_checked, row.notes].map(csvField).join(",") + "\n";
}

export function parseLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function parseCompaniesCsv(text: string): CompanyRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, idx) => {
      row[key] = values[idx] ?? "";
    });
    return row as unknown as CompanyRow;
  });
}
