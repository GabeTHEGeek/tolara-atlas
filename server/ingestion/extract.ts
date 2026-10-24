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
  // An optional "/yr" after the first figure: "$140,300/yr to $260,500/yr"
  // (Genentech).
  /(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3}(?:\.\d{2})?|k)(?:\s?\/\s?(?:yr|year))?\s?(?:-|to|–|—)\s?(?:USD|US\$|\$)?\s?\d{1,3}(?:,\d{3}(?:\.\d{2})?|k)/i,
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
// Global, so every candidate can be tested against its context below.
const SINGLE_PATTERN = /(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3}|k)\s?(?:\/\s?(?:yr|year|hour|hr)|per\s?(?:year|yr|hour))?/gi;

// A lone dollar figure only counts as pay when the words just before it say
// so -- and never when they describe a benefit. Without this, "401(k) match
// up to $12,000 annually" was stored as a $12k salary.
const PAY_CONTEXT = /\b(salary|pay|base|compensation|wage|earn|range|rate)\b/i;
const BENEFIT_CONTEXT = /\b(401\(?k\)?|match|bonus|stipend|reimburse\w*|allowance|tuition|signing|sign-on|relocation|equity|commission|budget|credit|award|referral)\b/i;

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
  for (const match of text.matchAll(SINGLE_PATTERN)) {
    // Only the figure's own sentence: a stipend mentioned in the sentence
    // before mustn't veto "Compensation: $165,000".
    const before = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index).split(/[.;!?]\s/).pop() ?? "";
    if (PAY_CONTEXT.test(before) && !BENEFIT_CONTEXT.test(before)) return match[0].trim();
  }
  return "";
}
