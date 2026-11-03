/**
 * match/onboarding.ts
 * The onboarding quiz: a few multiple-choice questions whose answers become
 * the candidate's Preferences. Every question has a "no preference" answer,
 * and that answer takes its category out of the score altogether -- so a
 * new user who skips the quiz is ranked on resume fit alone (domain, level,
 * requirements), never on someone else's cities or pay.
 *
 * The questions are data, so a UI can render them as they are.
 */

import type { Level, Preferences, StagePreference } from "./rubric.js";

export interface Option {
  id: string;
  label: string;
}

export interface Question {
  id: keyof Answers;
  prompt: string;
  multi: boolean;
  options: Option[];
}

export interface Answers {
  levels: string[]; // ["resume"] or Levels -- every level the candidate would take
  locations: string[]; // metro ids, "remote", or ["anywhere"]
  alsoConsider: string[]; // second-choice metros; [] for none
  relocate: string; // "yes" | "no"
  payFloor: string; // "none" or a number of dollars
  companyStage: string; // "any" or a CompanyStage
  skipAiStartups: string; // "yes" | "no"
}

// Cities as the export spells them ("New York City" and "New York" both
// occur). A metro is matched by any of its cities.
export const METROS: Record<string, { label: string; cities: string[] }> = {
  nyc: {
    label: "New York City area",
    cities: ["New York, NY", "New York City, NY", "Brooklyn, NY", "Jersey City, NJ", "Hoboken, NJ", "Newark, NJ", "Stamford, CT"],
  },
  dc: {
    label: "Washington DC / Baltimore",
    cities: [
      "Washington, DC", "Arlington, VA", "Alexandria, VA", "McLean, VA", "Reston, VA", "Herndon, VA", "Tysons, VA",
      "Bethesda, MD", "Rockville, MD", "Silver Spring, MD", "Baltimore, MD", "Towson, MD", "Columbia, MD",
    ],
  },
  bay: {
    label: "San Francisco Bay Area",
    cities: [
      "San Francisco, CA", "South San Francisco, CA", "Oakland, CA", "Palo Alto, CA", "East Palo Alto, CA", "Menlo Park, CA",
      "Mountain View, CA", "Sunnyvale, CA", "San Jose, CA", "Santa Clara, CA", "Cupertino, CA", "Redwood City, CA",
      "San Mateo, CA", "Foster City, CA", "Burlingame, CA", "San Bruno, CA", "Los Gatos, CA", "Bay Area, CA",
    ],
  },
  seattle: {
    label: "Seattle area",
    cities: ["Seattle, WA", "Bellevue, WA", "Redmond, WA", "Kirkland, WA"],
  },
  la: {
    label: "Los Angeles / Southern California",
    cities: ["Los Angeles, CA", "Culver City, CA", "Santa Monica, CA", "Hawthorne, CA", "Irvine, CA", "Costa Mesa, CA", "San Diego, CA"],
  },
  boston: {
    label: "Boston area",
    cities: ["Boston, MA", "Cambridge, MA", "Somerville, MA", "Waltham, MA"],
  },
  chicago: { label: "Chicago", cities: ["Chicago, IL"] },
  texas: { label: "Austin / Dallas", cities: ["Austin, TX", "Dallas, TX", "Plano, TX"] },
  southeast: { label: "Atlanta / Charlotte / Raleigh", cities: ["Atlanta, GA", "Charlotte, NC", "Cary, NC", "Durham, NC", "Raleigh, NC"] },
  denver: { label: "Denver / Boulder", cities: ["Denver, CO", "Boulder, CO"] },
};

const metroOptions: Option[] = Object.entries(METROS).map(([id, m]) => ({ id, label: m.label }));

export const QUESTIONS: Question[] = [
  {
    id: "levels",
    prompt: "Which levels would you take? Pick every one that fits.",
    multi: true,
    options: [
      { id: "resume", label: "Match my experience (read from my resume)" },
      { id: "associate", label: "Associate / APM" },
      { id: "mid", label: "Product Manager" },
      { id: "senior", label: "Senior PM" },
      { id: "principal", label: "Lead / Principal / Staff PM" },
      { id: "director", label: "Group PM / Director (no reports required)" },
    ],
  },
  {
    id: "locations",
    prompt: "Where do you want to work?",
    multi: true,
    options: [{ id: "anywhere", label: "Anywhere in the US -- no preference" }, { id: "remote", label: "Remote" }, ...metroOptions],
  },
  {
    id: "alsoConsider",
    prompt: "Anywhere else you'd consider, as a second choice?",
    multi: true,
    options: metroOptions,
  },
  {
    id: "relocate",
    prompt: "Would you relocate for the right role?",
    multi: false,
    options: [
      { id: "no", label: "No" },
      { id: "yes", label: "Yes" },
    ],
  },
  {
    id: "payFloor",
    prompt: "What's the least base pay you'd take?",
    multi: false,
    options: [
      { id: "none", label: "No preference" },
      ...[100_000, 130_000, 150_000, 180_000, 200_000, 250_000].map((n) => ({ id: String(n), label: `$${n / 1000}k` })),
    ],
  },
  {
    id: "companyStage",
    prompt: "What kind of company do you want?",
    multi: false,
    options: [
      { id: "any", label: "No preference" },
      { id: "established", label: "Large or public" },
      { id: "growth", label: "Growth stage (Series B-D)" },
      { id: "seed", label: "Early-stage startup" },
    ],
  },
  {
    id: "skipAiStartups",
    prompt: "Skip AI-native startups hiring for AI-titled roles?",
    multi: false,
    options: [
      { id: "no", label: "No" },
      { id: "yes", label: "Yes" },
    ],
  },
];

/** A user who skips the quiz: no preferences, level read from the resume. */
export const GENERIC_ANSWERS: Answers = {
  levels: ["resume"],
  locations: ["anywhere"],
  alsoConsider: [],
  relocate: "no",
  payFloor: "none",
  companyStage: "any",
  skipAiStartups: "no",
};

const LEVELS: Level[] = ["associate", "mid", "senior", "principal", "director"];
const STAGES: StagePreference[] = ["established", "growth", "seed"];

function levelsOf(ids: string[] | string): Level[] | null {
  // An answers file from before the question took several answers has one string.
  const picked = (Array.isArray(ids) ? ids : [ids]).filter((id): id is Level => LEVELS.includes(id as Level));
  return picked.length > 0 ? picked : null;
}

function citiesOf(ids: string[]): string[] {
  return ids.flatMap((id) => (id === "remote" ? ["Remote US"] : (METROS[id]?.cities ?? [])));
}

/** Answers -> Preferences. Unknown or missing answers fall back to the generic ones. */
export function preferencesFrom(partial: Partial<Answers>): Preferences {
  const a = { ...GENERIC_ANSWERS, ...partial };
  const anywhere = a.locations.length === 0 || a.locations.includes("anywhere");
  const floor = Number(a.payFloor);
  return {
    targetLevels: levelsOf(a.levels),
    locations: anywhere
      ? null
      : { preferred: citiesOf(a.locations), secondary: citiesOf(a.alsoConsider), relocationOk: a.relocate === "yes" },
    // The target is a fifth above the floor, to the nearest $10k: a band
    // topping out there is comfortably, not barely, acceptable.
    pay: Number.isFinite(floor) && floor > 0 ? { floor, target: Math.round((floor * 1.2) / 10_000) * 10_000 } : null,
    companyStage: STAGES.includes(a.companyStage as StagePreference) ? (a.companyStage as StagePreference) : null,
    skipAiFirstStartups: a.skipAiStartups === "yes",
  };
}
