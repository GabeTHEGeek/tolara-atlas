/**
 * ingestion/csv.ts
 * Minimal CSV reader for data/companies.csv. No external dependency — the
 * file is simple (no embedded commas/quotes in practice, since it's
 * machine-written by Maester's discovery tool), but this still handles
 * basic quoted fields defensively in case that ever changes.
 */

export interface CompanyRow {
  company: string;
  token: string;
  platform: "greenhouse" | "ashby" | "lever" | "bamboohr" | "workday" | "paylocity" | "icims" | "tiktok" | "apple" | "meta" | "gem" | string;
  status: "verified" | "unverified" | "failed" | string;
  last_checked: string;
  notes: string;
}

function parseLine(line: string): string[] {
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
