/**
 * format.ts
 * Small display helpers shared by the panels. Both of these were copied
 * per-component before; they're here so a salary or a timestamp reads the
 * same wherever it appears.
 */

export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export type SalaryPeriod = "year" | "hour" | "month";

// Currencies we can render as a symbol. Anything else falls back to its ISO
// code, printed once ("SGD 171k – 345k") rather than on both figures.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "CA$",
  AUD: "A$",
  NZD: "NZ$",
  GBP: "£",
  EUR: "€",
  JPY: "¥",
  INR: "₹",
  KRW: "₩",
  BRL: "R$",
};

const PERIOD_SUFFIX: Record<SalaryPeriod, string> = { year: "", hour: " / hr", month: " / mo" };

/** 165000 -> "165k", 156600 -> "156.6k", 1200000 -> "1.2M". */
function abbreviate(n: number): string {
  const scaled = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
  };
  if (n >= 1_000_000) return scaled(n / 1_000_000, "M");
  if (n >= 1_000) return scaled(n / 1_000, "k");
  return String(n);
}

/**
 * A band as the posting stated it -- never an estimate, and never converted
 * between periods. Null when no figure was published.
 *
 * Hourly and monthly figures are printed in full and suffixed, because
 * "$70" abbreviated the way an annual number is would read as $70,000.
 */
export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: SalaryPeriod | null = "year",
): string | null {
  if (min == null && max == null) return null;
  const per = period ?? "year";
  const code = currency ?? "USD";
  const symbol = CURRENCY_SYMBOLS[code];

  const num = (n: number) => (per === "year" ? abbreviate(n) : n.toLocaleString("en-US"));
  // With a symbol, both figures carry it ("$165k – $195k"); with a bare ISO
  // code, repeating it reads like two separate prices, so it leads instead.
  const first = (n: number) => (symbol ? `${symbol}${num(n)}` : `${code} ${num(n)}`);
  const second = (n: number) => (symbol ? `${symbol}${num(n)}` : num(n));
  const suffix = PERIOD_SUFFIX[per];

  if (min != null && max != null && min !== max) return `${first(min)} – ${second(max)}${suffix}`;
  if (min == null) return `up to ${first(max!)}${suffix}`;
  if (max == null) return `from ${first(min)}${suffix}`;
  return `${first(min)}${suffix}`;
}
