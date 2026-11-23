/**
 * resumeGuess.ts
 * A first guess at the match quiz's experience answers from a resume's
 * text, with plain rules and no AI: the visitor sees every answer filled
 * in and corrects what's wrong before scoring. Free and private (it runs
 * in this browser), but rough. The paid upgrade is one model call that
 * reads the resume the way server/match/profile.ts does.
 *
 *   - Years: every date range ("March 2021 - May 2022", "2018 - Present",
 *     "06/2017 - 03/2021"), labelled by the job title just before it (or
 *     just after). Product titles count as PM years, founder titles as
 *     founder years; overlapping jobs aren't double counted.
 *   - Kinds of product and ML depth: weighted keywords, each counted at
 *     most a few times so one repeated word can't decide it.
 *   - Product areas: a fixed list of industries the text mentions.
 */

import type { Archetype } from "../server/match/archetypes.js";
import type { QuizAnswers } from "./quizMatch.js";

export interface ResumeGuess {
  answers: Pick<QuizAnswers, "pmYears" | "founderYears" | "primary" | "some" | "domains" | "mlDepth" | "managedPeople">;
  jobs: Array<{ title: string; years: number; kind: "pm" | "founder" }>;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const POINT = `(?:${MONTH}\\s*'?\\d{2,4}|\\d{1,2}\\s*/\\s*\\d{4}|(?:19|20)\\d{2})`;
const RANGE = new RegExp(`(${POINT})\\s*(?:-|to|until)\\s*(${POINT}|present|current|now|today|ongoing)`, "gi");

const PRODUCT_TITLE =
  /\b(product\s+(manager|lead|owner|director|management|leader)|head\s+of\s+product|(director|vp|vice\s+president|chief|svp|evp)\b[^\n]{0,20}\bproduct|cpo\b|gpm\b|apm\b|(senior|principal|staff|group|lead|associate)\s+pm\b|\bpm\s*,)/i;
const FOUNDER_TITLE = /\b(co-?\s?founder|founder|founding\s+ceo)\b/i;

/** Month index (years * 12 + month) for a date like "March 2021", "03/2021", "2021"; null if unreadable. */
function monthIndex(raw: string, isEnd: boolean, now: Date): number | null {
  const s = raw.toLowerCase().trim();
  if (/present|current|now|today|ongoing/.test(s)) return now.getFullYear() * 12 + now.getMonth();
  let m = s.match(/^([a-z]+)\.?\s*'?(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, m[1].startsWith("sept") ? 4 : 3)];
    let year = Number(m[2]);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    return month == null ? null : year * 12 + month;
  }
  m = s.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
  if (m) return Number(m[2]) * 12 + Math.min(11, Math.max(0, Number(m[1]) - 1));
  m = s.match(/^(\d{4})$/);
  if (m) return Number(m[1]) * 12 + (isEnd ? 11 : 0);
  return null;
}

/** Total months covered by intervals, overlaps counted once. */
function unionMonths(spans: Array<[number, number]>): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [s, e] of sorted) {
    if (!cur || s > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    } else cur[1] = Math.max(cur[1], e);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// [pattern, weight]. Matched case-insensitively on word boundaries.
const ARCHETYPE_WORDS: Record<Archetype, Array<[string, number]>> = {
  "ai-agents": [["llms?", 3], ["genai", 3], ["generative ai", 3], ["ai agents?", 3], ["agentic", 3], ["chatbots?", 2], ["copilots?", 2], ["prompt", 2], ["rag", 2], ["openai", 2], ["ai[- ]powered", 2], ["conversational ai", 3], ["automation", 1], ["ai", 0.5]],
  platform: [["apis?", 1.5], ["sdks?", 2], ["developers?", 2], ["developer tools", 3], ["platform", 1], ["infrastructure", 2], ["integrations?", 1], ["cloud", 1], ["devops", 2], ["open source", 2]],
  data: [["data platform", 3], ["analytics", 1.5], ["dashboards?", 1], ["data pipelines?", 3], ["data warehouse", 3], ["business intelligence", 3], ["ml platform", 3], ["machine learning", 2], ["data science", 1], ["data products?", 3], ["etl", 2]],
  growth: [["growth", 2], ["engagement", 2], ["retention", 2], ["activation", 2], ["onboarding", 1.5], ["conversion", 1.5], ["funnels?", 1.5], ["community", 2], ["creators?", 2], ["acquisition", 1.5], ["referrals?", 1.5], ["viral", 2], ["lifecycle", 1.5], ["a/b test(s|ing)?", 1.5], ["experiment(s|ation)?", 1.5], ["personalization", 1.5]],
  marketplace: [["marketplaces?", 3], ["two-sided", 3], ["buyers?", 1.5], ["sellers?", 1.5], ["supply", 1], ["matching", 1.5], ["gig", 2], ["listings?", 1.5], ["hosts", 1.5], ["merchants?", 1]],
  monetization: [["payments?", 3], ["payouts?", 2], ["billing", 2.5], ["checkout", 2.5], ["subscriptions?", 2], ["pricing", 2], ["monetization", 3], ["fintech", 3], ["banking", 2.5], ["lending", 2.5], ["credit", 1.5], ["advertising", 2], ["ads", 1.5], ["revenue", 0.5]],
  "b2b-saas": [["saas", 3], ["b2b", 3], ["enterprise", 2.5], ["crm", 2], ["workflows?", 1.5], ["admin", 1], ["smb", 2], ["erp", 2], ["procurement", 2], ["hr tech", 2], ["customers", 0.3]],
  consumer: [["consumer", 3], ["mobile app", 2.5], ["ios", 1.5], ["android", 1.5], ["b2c", 3], ["social", 1.5], ["app store", 2], ["millions of users", 2], ["streaming", 1.5], ["gaming", 1.5], ["e-?commerce", 1.5]],
  security: [["security", 3], ["identity", 2], ["authentication", 2.5], ["fraud", 2.5], ["trust (&|and) safety", 3], ["compliance", 1.5], ["privacy", 1.5], ["risk", 1], ["verification", 1.5], ["kyc", 2.5], ["cyber", 3]],
  hardware: [["hardware", 3], ["devices?", 1.5], ["robotics?", 3], ["firmware", 3], ["iot", 3], ["sensors?", 2], ["manufacturing", 2], ["embedded", 2.5], ["semiconductors?", 3], ["wearables?", 3]],
  internal: [["internal tools?", 3], ["operations", 1], ["back[- ]office", 3], ["employee", 1.5], ["support tools", 3], ["tooling", 1.5], ["internal platform", 3], ["workforce", 2]],
};

const DOMAINS: Array<[string, RegExp]> = [
  ["payments", /\bpayments?\b/i],
  ["fintech", /\bfintech|banking|lending\b/i],
  ["insurance", /\binsurance|insurtech|warrant(y|ies)/i],
  ["healthcare", /\bhealth ?care|healthtech|clinical|patients?\b/i],
  ["education", /\bedtech|learning platform|students|teachers|k-12\b/i],
  ["e-commerce", /\be-?commerce|retail|shopping\b/i],
  ["travel", /\btravel|hospitality|hotels?\b/i],
  ["real estate", /\breal estate|proptech|mortgage\b/i],
  ["gaming", /\bgaming|video games?\b/i],
  ["live streaming", /\blive ?stream(ing)?\b/i],
  ["creator tools", /\bcreators?\b/i],
  ["podcasts and audio", /\bpodcasts?|audio\b/i],
  ["music", /\bmusic\b/i],
  ["advertising", /\badvertising|ad ?tech|programmatic\b/i],
  ["crypto and web3", /\bcrypto|web3|blockchain\b/i],
  ["automotive", /\bautomotive|vehicles?\b/i],
  ["logistics", /\blogistics|supply chain|shipping|delivery\b/i],
  ["social", /\bsocial (network|media|platform)\b/i],
  ["developer tools", /\bdeveloper tools|devtools\b/i],
  ["cybersecurity", /\bcyber ?security\b/i],
  ["HR and recruiting", /\brecruiting|hiring platform|hr tech\b/i],
  ["climate and energy", /\bclimate|energy|solar\b/i],
  ["media", /\bmedia (company|platform)|publishing|newsroom\b/i],
];

const ML_DEEP = /\b(train(ed|ing)?\s+(ml\s+|machine learning\s+|deep learning\s+)?models?|model training|pytorch|tensorflow|ml infrastructure|ml platform|feature store|ranking models?|recommendation models?|computer vision|deep learning|model serving|mlops)\b/gi;
const ML_APPLIED = /\b(llms?|genai|generative ai|ai agents?|agentic|prompt(s| engineering)?|rag|openai|gpt|claude|gemini|ai[- ]powered|copilots?|chatbots?|embeddings|fine-?tun(e|ed|ing))\b/gi;

const MANAGED =
  /\b(manag(ed|ing|e)|led|leading|hired|mentored|built and led|grew)\b[^.\n●•]{0,40}\b(pms|product managers|product team|designers|direct reports|reports|team of \d+ (pms|product))\b|\bdirect(ly)? manag/i;
const LEAD_TITLE = /\b(director|vp|vice president|head of product|group product manager|gpm|chief product)\b/i;

/** The job line out of the text around a date range: "Twitch - Product Manager", not the bullet before it. */
function cleanTitle(label: string): string {
  let t = label.split(/\n|●|•|\|\s{2,}|\.\s/).map((s) => s.trim()).filter(Boolean).pop() ?? label.trim();
  t = t.replace(/^([A-Z]{3,}\s+)+/, "").replace(/[\s(,:-]+$/, "");
  // "...content discovery Twitch - Product Manager": keep the capitalised company name before the dash.
  const dash = t.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if (dash) {
    const company = dash[1].split(/\s+/).reverse();
    const kept: string[] = [];
    for (const w of company) {
      if (!/^[A-Z0-9&]/.test(w) || kept.length === 3) break;
      kept.unshift(w);
    }
    if (kept.length) t = `${kept.join(" ")} - ${dash[2]}`;
  }
  return t.slice(-90);
}

function countHits(text: string, pattern: string, cap = 4): number {
  const n = text.match(new RegExp(`\\b${pattern}\\b`, "gi"))?.length ?? 0;
  return Math.min(n, cap);
}

const QUIZ_YEARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
function nearestOption(years: number, options: number[]): number {
  return options.reduce((best, o) => (Math.abs(o - years) < Math.abs(best - years) ? o : best), options[0]);
}

export function guessFromResume(raw: string, now = new Date()): ResumeGuess {
  const text = raw.replace(/[‐-―−]/g, "-").replace(/\r/g, "");

  // Jobs: each date range, labelled by the text just before it (or after).
  const pmSpans: Array<[number, number]> = [];
  const founderSpans: Array<[number, number]> = [];
  const jobs: ResumeGuess["jobs"] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(RANGE)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(lastEnd, at - 140), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 80).split(/\n|●|•/)[0];
    lastEnd = at + m[0].length;
    const start = monthIndex(m[1], false, now);
    const end = monthIndex(m[2], true, now);
    if (start == null || end == null || end <= start || end - start > 40 * 12) continue;
    const label = PRODUCT_TITLE.test(before) || FOUNDER_TITLE.test(before) ? before : after;
    const founder = FOUNDER_TITLE.test(label);
    const pm = PRODUCT_TITLE.test(label);
    if (!founder && !pm) continue;
    (founder ? founderSpans : pmSpans).push([start, end]);
    jobs.push({ title: cleanTitle(label), years: Math.round(((end - start) / 12) * 10) / 10, kind: founder ? "founder" : "pm" });
  }
  const founderMonths = unionMonths(founderSpans);
  // PM time that overlaps founder time is already counted as founder time.
  const pmMonths = Math.max(0, unionMonths([...pmSpans, ...founderSpans]) - founderMonths);

  // Kinds of product.
  const scores = (Object.keys(ARCHETYPE_WORDS) as Archetype[])
    .map((a) => ({ a, score: ARCHETYPE_WORDS[a].reduce((sum, [p, w]) => sum + countHits(text, p) * w, 0) }))
    .sort((x, y) => y.score - x.score);
  const top = scores[0]?.score ?? 0;
  const primary = scores.filter((s) => s.score >= 6 && s.score >= top * 0.45).slice(0, 3).map((s) => s.a);
  if (primary.length === 0 && top >= 2) primary.push(scores[0].a);
  const some = scores.filter((s) => !primary.includes(s.a) && s.score >= 4).slice(0, 3).map((s) => s.a);

  const domains = DOMAINS.map(([label, re]) => ({ label, n: text.match(new RegExp(re.source, "gi"))?.length ?? 0 }))
    .filter((d) => d.n > 0)
    .sort((x, y) => y.n - x.n)
    .slice(0, 6)
    .map((d) => d.label);

  const deep = text.match(ML_DEEP)?.length ?? 0;
  const applied = text.match(ML_APPLIED)?.length ?? 0;
  const mlDepth: QuizAnswers["mlDepth"] = deep >= 2 ? "deep" : applied >= 2 || deep === 1 ? "applied" : "none";

  const managedPeople = MANAGED.test(text) || jobs.some((j) => j.kind === "pm" && LEAD_TITLE.test(j.title));

  return {
    answers: {
      pmYears: nearestOption(pmMonths / 12, QUIZ_YEARS),
      founderYears: founderMonths > 0 ? Math.max(1, nearestOption(founderMonths / 12, QUIZ_YEARS.slice(1, 9))) : 0,
      primary,
      some,
      domains: domains.join(", "),
      mlDepth,
      managedPeople,
    },
    jobs,
  };
}
