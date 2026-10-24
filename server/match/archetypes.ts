/**
 * match/archetypes.ts
 * The kinds of PM work a role can be, and which are close to each other.
 *
 * Maester's tailoring step classifies a listing into AI-flavoured PM
 * archetypes; this is the same idea widened to the whole market Tolara
 * covers (payments PMs, hardware PMs, consumer app PMs), because Domain
 * match is scored by comparing a role's archetype with the ones the
 * candidate has actually done.
 */

export const ARCHETYPES = {
  "ai-agents": "AI agents, LLM features and automation",
  platform: "Platform, APIs and developer tools",
  data: "Data, analytics and ML platforms",
  growth: "Growth, engagement, community and creators",
  marketplace: "Marketplaces and two-sided platforms",
  monetization: "Monetization, payments and fintech",
  "b2b-saas": "B2B SaaS workflows and enterprise",
  consumer: "Consumer apps and experiences",
  security: "Security, identity and trust",
  hardware: "Hardware, robotics and physical products",
  internal: "Internal tools and operations",
} as const;

export type Archetype = keyof typeof ARCHETYPES;

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as Archetype[];

// Pairs close enough that experience in one is "adjacent" for the other.
// Symmetric by construction (see isAdjacent).
const ADJACENT: Array<[Archetype, Archetype]> = [
  ["ai-agents", "platform"],
  ["ai-agents", "data"],
  ["ai-agents", "b2b-saas"],
  ["platform", "data"],
  ["platform", "b2b-saas"],
  ["platform", "security"],
  ["growth", "consumer"],
  ["growth", "marketplace"],
  ["growth", "monetization"],
  ["marketplace", "monetization"],
  ["marketplace", "consumer"],
  ["b2b-saas", "internal"],
  ["b2b-saas", "security"],
  ["data", "internal"],
];

export function isAdjacent(a: Archetype, b: Archetype): boolean {
  return ADJACENT.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === "string" && value in ARCHETYPES;
}
