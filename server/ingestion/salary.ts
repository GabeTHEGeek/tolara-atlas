/**
 * ingestion/salary.ts
 * Turns an ATS's salary string into numbers.
 *
 * This used to be a few lines inside sync.ts that stripped commas and read
 * whatever digits were left, which silently mangled every board that
 * abbreviates thousands: Ashby's compensationTierSummary is formatted
 * "$257K – $335K • Offers Equity", so a $257,000–$335,000 role was stored
 * as 257–335 and rendered as "USD 257 – USD 335". About a third of all
 * banded roles came from boards that write it that way.
 *
 * The real shapes this has to survive, all observed live:
 *   "$257K – $335K • Offers Equity"
 *   "$156.6K – $276K • Offers Equity • Offers Commission • Multiple Ranges"
 *   "$145,760 – $200,420"
 *   "$189K – $220.5K • Offers Equity • $189K – $220.5K Commission"
 *   "$110K – $120K • ... • Total OTE with 70/30 split"
 *   "$57 – $70 per hour"
 *   "CA$140K – CA$188K"   "£194K – £280K"   "SGD 171K – SGD 345K"
 *   "$380K • Offers Equity"          (single figure, not a range)
 *   "$0 – $500K • Offers Equity"     (no real floor)
 *   "USD 120,000 - 150,000"          (what our own adapters build)
 *
 * Two of those shapes are why everything after the first "•" is discarded
 * before any digit is read: a trailing commission range and a "70/30 split"
 * both contain numbers that would otherwise be mistaken for the pay band.
 */

export type SalaryPeriod = "year" | "hour" | "month";

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  // What the figures are PER. Stored rather than annualized: turning "$70
  // per hour" into "$145,600 a year" invents an assumption about full-time
  // hours that the posting never made, and the UI promises these numbers
  // come from the posting.
  period: SalaryPeriod;
}

const EMPTY: ParsedSalary = { min: null, max: null, currency: null, period: "year" };

// Longest first: "CA$" and "US$" have to beat a bare "$".
const CURRENCY_SYMBOLS: Array<[string, string]> = [
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["NZ$", "NZD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["US$", "USD"],
  ["R$", "BRL"],
  ["$", "USD"],
  ["£", "GBP"],
  ["€", "EUR"],
  ["¥", "JPY"],
  ["₹", "INR"],
  ["₩", "KRW"],
];

function detectCurrency(text: string): string | null {
  // An explicit ISO code anywhere ("SGD 171K", "USD 120,000 - 150,000")
  // beats a symbol, since it's unambiguous.
  const code = text.match(/\b([A-Z]{3})\b/);
  if (code && code[1] !== "OTE") return code[1];
  for (const [symbol, currency] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) return currency;
  }
  return null;
}

function detectPeriod(text: string): SalaryPeriod {
  if (/(?:per\s*hour|\/\s*(?:hour|hr)\b|\bhourly\b|\ban\s*hour\b)/i.test(text)) return "hour";
  if (/(?:per\s*month|\/\s*(?:month|mo)\b|\bmonthly\b|\ba\s*month\b)/i.test(text)) return "month";
  return "year";
}

// A number with optional thousands separators or a decimal, plus an
// optional multiplier suffix: 257K, 156.6K, 145,760, 70, 1.2M, and the
// Indian lakh/crore forms (30L, 1.5Cr) that Ashby passes through verbatim
// for INR bands. The suffix must be attached to the digits -- allowing a
// space would let "$100 Lunch stipend" read as a hundred lakh.
const AMOUNT = /(\d[\d,]*(?:\.\d+)?)(Cr|cr|[KkMmLl])?/g;

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  l: 100_000, // lakh
  cr: 10_000_000, // crore
};

function toAmount(digits: string, suffix: string | undefined): number | null {
  const value = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const scale = suffix ? (MULTIPLIERS[suffix.toLowerCase()] ?? 1) : 1;
  return Math.round(value * scale);
}

/**
 * Everything after the first bullet is metadata about the offer (equity,
 * commission, "Multiple Ranges", an OTE split) -- never the base band, and
 * frequently full of numbers that look like one.
 */
function payBandSegment(raw: string): string {
  const bulletAt = raw.search(/[•·|]/);
  return (bulletAt === -1 ? raw : raw.slice(0, bulletAt)).trim();
}

export function parseSalary(raw: string | null | undefined): ParsedSalary {
  if (!raw || !raw.trim()) return EMPTY;
  const segment = payBandSegment(raw);
  if (!segment) return EMPTY;

  const amounts: number[] = [];
  AMOUNT.lastIndex = 0;
  for (const match of segment.matchAll(AMOUNT)) {
    const amount = toAmount(match[1], match[2]);
    if (amount != null) amounts.push(amount);
    if (amounts.length === 2) break; // a band is two numbers; the rest is noise
  }
  if (amounts.length === 0) return EMPTY;

  const currency = detectCurrency(segment);
  const period = detectPeriod(segment);

  let [min, max] = amounts.length === 2 ? amounts : [amounts[0], amounts[0]];
  if (min > max) [min, max] = [max, min];

  return {
    // "$0 – $500K" states no real floor; 0 is a placeholder, not a number
    // anyone is offering, and it drags every average down if kept.
    min: min > 0 ? min : null,
    max: max > 0 ? max : null,
    currency,
    period,
  };
}
