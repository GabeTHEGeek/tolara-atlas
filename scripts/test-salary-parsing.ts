/**
 * scripts/test-salary-parsing.ts
 * Table test for server/ingestion/salary.ts. Every input here is a real
 * string observed on a live board (Ashby compensationTierSummary, or what
 * our own greenhouse/lever/tiktok adapters build), kept because the old
 * parser got a third of them wrong by ignoring the K suffix.
 *
 * Usage: npx tsx scripts/test-salary-parsing.ts
 */

import { parseSalary } from "../server/ingestion/salary.js";

const cases: Array<[string, string]> = [
  ["$257K – $335K • Offers Equity", "257000-335000 USD year"],
  ["$156.6K – $276K • Offers Equity • Offers Commission • Multiple Ranges", "156600-276000 USD year"],
  ["$145,760 – $200,420", "145760-200420 USD year"],
  ["$189K – $220.5K • Offers Equity • $189K – $220.5K Commission", "189000-220500 USD year"],
  ["$110K – $120K • Offers Equity • Offers Commission • Total OTE with 70/30 split", "110000-120000 USD year"],
  ["$57 – $70 per hour", "57-70 USD hour"],
  ["$60.58 – $108.17 per hour • Offers Equity", "61-108 USD hour"],
  ["CA$140K – CA$188K • Offers Equity", "140000-188000 CAD year"],
  ["£194K – £280K", "194000-280000 GBP year"],
  ["SGD 171K – SGD 345K • Offers Equity", "171000-345000 SGD year"],
  ["$380K • Offers Equity", "380000-380000 USD year"],
  ["$0 – $500K • Offers Equity", "null-500000 USD year"],
  ["USD 120,000 - 150,000", "120000-150000 USD year"],
  ["USD 150,000", "150000-150000 USD year"],
  ["$120k-$150k", "120000-150000 USD year"],
  ["$80,000-$100,000/yr", "80000-100000 USD year"],
  ["$50 - $75/hour", "50-75 USD hour"],
  ["", "null-null null year"],
  ["Competitive", "null-null null year"],
  ["$1.2M – $1.5M", "1200000-1500000 USD year"],
  ["$5,000 - $8,000 per month", "5000-8000 USD month"],
  ["₹30L – ₹37.5L • Offers Equity", "3000000-3750000 INR year"],
  ["₹1.5Cr – ₹2Cr", "15000000-20000000 INR year"],
];

let failed = 0;

for (const [input, expected] of cases) {
  const r = parseSalary(input);
  const got = `${r.min ?? "null"}-${r.max ?? "null"} ${r.currency ?? "null"} ${r.period}`;
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(input).padEnd(72)} -> ${got}${ok ? "" : `   (expected ${expected})`}`);
}
console.log(failed === 0 ? `\nAll ${cases.length} cases pass.` : `\n${failed} of ${cases.length} FAILED`);
if (failed > 0) process.exitCode = 1;
