/**
 * seoFacts.ts
 * The plain-language facts and FAQ answers about the board, worked out from
 * map-data.json. One source for both the landing page's FAQ section and the
 * static pages the build writes for search engines and AI answer engines
 * (server/seo), so what a crawler reads is exactly what a visitor sees.
 */

import { landingRoles, payByLevel, slice, METROS, type LandingRole, type MetroId } from "./landingStats.js";
import type { MapData } from "./types.js";

const fmt = (n: number) => n.toLocaleString("en-US");
const k = (n: number) => `$${Math.round(n / 1000)}K`;

export interface SiteFacts {
  updated: string; // ISO
  updatedLabel: string; // "November 24, 2026"
  openRoles: number;
  liveRoles: number;
  companies: number;
  ghostRoles: number;
  ghostShare: number; // 0-1
  addedThisWeek: number;
  closedThisWeek: number;
  windowDays: number;
  withPayShare: number; // 0-1
  medianPayTop: number | null;
  payByLevel: Array<{ label: string; pay: number; sample: number }>;
  metros: Array<{ id: MetroId; label: string; open: number; live: number }>;
  topCompanies: Array<{ slug: string; name: string; open: number }>;
}

export function siteFacts(data: MapData, now: number = Date.parse(data.generatedAt)): SiteFacts {
  const roles = landingRoles(data, now);
  const all = slice(roles, "all", "all");
  const counts = new Map<string, { slug: string; name: string; open: number }>();
  for (const r of roles) {
    const c = counts.get(r.companySlug) ?? { slug: r.companySlug, name: r.companyName, open: 0 };
    c.open += 1;
    counts.set(r.companySlug, c);
  }
  return {
    updated: data.generatedAt,
    updatedLabel: new Date(data.generatedAt).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
    openRoles: all.open,
    liveRoles: all.live,
    companies: counts.size,
    ghostRoles: all.ghost,
    ghostShare: all.open ? all.ghost / all.open : 0,
    addedThisWeek: data.changes.added,
    closedThisWeek: data.changes.closed,
    windowDays: data.changes.windowDays,
    withPayShare: roles.length ? roles.filter((r) => hasBand(r)).length / roles.length : 0,
    medianPayTop: all.medianPayTop,
    payByLevel: payByLevel(roles).map(({ label, pay, sample }) => ({ label, pay, sample })),
    metros: METROS.filter(([id]) => id !== "all").map(([id, label]) => {
      const s = slice(roles, "all", id);
      return { id, label, open: s.open, live: s.live };
    }),
    topCompanies: [...counts.values()].sort((a, b) => b.open - a.open).slice(0, 12),
  };
}

function hasBand(r: LandingRole): boolean {
  return r.role.salaryMin != null || r.role.salaryMax != null;
}

export interface Faq {
  q: string;
  a: string;
}

/** Short, answer-first FAQ entries, each standing on its own. */
export function siteFaqs(f: SiteFacts): Faq[] {
  const pay = f.payByLevel.map((p) => `${p.label} ${k(p.pay)}`).join(", ");
  const topMetros = [...f.metros]
    .filter((m) => m.id !== "remote")
    .sort((a, b) => b.open - a.open)
    .slice(0, 4)
    .map((m) => `${m.id === "bay" ? "the Bay Area" : m.label} (${fmt(m.open)})`)
    .join(", ");
  const remote = f.metros.find((m) => m.id === "remote");
  return [
    {
      q: "How many product manager jobs are open in the US right now?",
      a: `Tolara Scout is tracking ${fmt(f.openRoles)} open product manager roles at ${fmt(f.companies)} US companies as of ${f.updatedLabel}, read from each company's own careers site. That's every PM role at the companies it follows, not every PM job in the country. ${fmt(f.addedThisWeek)} opened and ${fmt(f.closedThisWeek)} closed in the last ${f.windowDays} days.`,
    },
    {
      q: "How much do product managers get paid in the US?",
      a: `The typical top of the posted pay band for the US product manager roles Tolara Scout tracks is ${f.medianPayTop ? k(f.medianPayTop) : "not yet known"}. By level: ${pay}. These come from pay bands companies publish in their postings, not from surveys.`,
    },
    {
      q: "Where are the most product manager jobs?",
      a: `The most open PM roles are in ${topMetros}.${remote ? ` ${fmt(remote.open)} roles are remote.` : ""}`,
    },
    {
      q: "What is a ghost job?",
      a: `A ghost job is a posting that stays up when the company may not be actively hiring for it. Tolara Scout flags a role as a possible ghost when it has been open 90 days or more, or was taken down, reposted and is still open after 45 days. ${Math.round(f.ghostShare * 100)}% of open US PM roles (${fmt(f.ghostRoles)}) are flagged today.`,
    },
    {
      q: "How often is Tolara Scout updated?",
      a: `Every day. Each company's careers site is read daily, so a role appears soon after it's posted and disappears once it's taken down. The last update was ${f.updatedLabel}.`,
    },
    {
      q: "Is Tolara Scout free?",
      a: "Yes. Sign up with your name and email to open the full job board and map, with pay bands, ghost flags and a match score for your experience. A Monday email comes with it, and you can turn it off any time.",
    },
  ];
}
