/**
 * extract.ts
 * Best-effort salary extraction from free text when an ATS doesn't give us a
 * structured field. Ported from Maester's utils/extract.py (extract_salary
 * only — the resume-parsing helpers in that file aren't relevant here).
 */

// Matches range patterns like "$120,000 - $150,000", "$120k-$150k",
// "$80,000-$100,000/yr", "USD 150,250 - 215,250", em/en dash included.
const RANGE_PATTERNS = [
  // Optional cents on either figure: "$188,997.50 - $255,863.00" (6sense).
  /(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3}(?:\.\d{2})?|k)\s?(?:-|to|–|—)\s?(?:USD|US\$|\$)?\s?\d{1,3}(?:,\d{3}(?:\.\d{2})?|k)/i,
  // "ranges from $175,000/year in our lowest geographic market up to
  // $220,000/year in our highest" (Coalition and other multi-market
  // postings). The gap is capped so "from $X" can't pair with an unrelated
  // "up to $Y" paragraphs later.
  /from\s+(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?(?:\s?\/\s?(?:yr|year))?[^$]{0,80}?\bup to\s+(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3})+/i,
  // "between $169,000 and $266,000" (Braze and many others). Gated on
  // "between" because a bare "$150,000 and $20,000" is as likely to be a
  // salary and a signing bonus as a range. Without this the range above
  // missed it and the single-figure fallback stored $169k-$169k.
  /between\s+(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s+and\s+(?:USD|US\$|\$)?\s?\d{1,3}(?:,\d{3})+/i,
  // Hourly rate ranges with bare 2-3 digit numbers, gated on an explicit
  // /hour or /hr suffix so bare small numbers elsewhere in the text don't
  // falsely match.
  /(?:USD|US\$|\$)\s?\d{1,3}\s?(?:-|to|–|—)\s?(?:USD|US\$|\$)?\s?\d{1,3}\s?\/\s?(?:hour|hr)\b/i,
];

// Fallback for a single stated figure, no range: "$150,000 per year", "$150K".
const SINGLE_PATTERNS = [
  /(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3}|k)\s?(?:\/\s?(?:yr|year|hour|hr)|per\s?(?:year|yr|hour))?/i,
];

/**
 * Tries ranges first (more informative), then falls back to a single stated
 * figure. Returns "" if nothing matches — never fabricates a number.
 */
export function extractSalary(text: string | null | undefined): string {
  if (!text) return "";
  for (const pattern of RANGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  for (const pattern of SINGLE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}
