/**
 * What each MCP tool answers, as plain functions over Tolara Scout's data.
 * They reuse the website's own code for filters, ghost jobs and pay ranks
 * (src/filters.ts, src/ghost.ts, src/payRank.ts), so an assistant and the
 * job board never disagree about which roles match.
 */

import { EMPTY_FILTERS, roleDate, roleMatches, type RemoteMode, type RoleFilters } from "../../src/filters.js";
import { daysOpenLabel, formatSalary, openSince } from "../../src/format.js";
import { ghostReason } from "../../src/ghost.js";
import { buildPayRanker, payRankShort, type PayRanker } from "../../src/payRank.js";
import { SENIORITY_LABELS, SENIORITY_TIERS, type MapData, type RoleData, type Seniority } from "../../src/types.js";
import { slugify } from "../../server/seo/generate.js";
import { getCompanyFile, getMapData, SITE_URL } from "./data.js";

const DAY = 86_400_000;

/** One role, its offices gathered from every pin it sits on (like the job board's rows). */
interface Row {
  role: RoleData;
  companyName: string;
  companySlug: string;
  cities: string[];
  remote: boolean;
  searchText: string;
}

let indexFor: { data: MapData; rows: Row[]; byId: Map<number, Row>; payRank: PayRanker } | null = null;

function index(data: MapData) {
  if (indexFor?.data === data) return indexFor;
  const byId = new Map<number, Row>();
  const add = (role: RoleData, companyName: string, companySlug: string, city: string | null) => {
    let row = byId.get(role.id);
    if (!row) {
      row = { role, companyName, companySlug, cities: [], remote: false, searchText: "" };
      byId.set(role.id, row);
    }
    // A remote role sits at its company's main office on the map only so it
    // has somewhere to be drawn; it isn't based there.
    if (role.isRemote) row.remote = true;
    else if (city && !row.cities.includes(city)) row.cities.push(city);
  };
  for (const pin of data.pins) {
    const city = pin.city ? [pin.city, pin.state].filter(Boolean).join(", ") : null;
    for (const role of pin.roles) add(role, pin.companyName, pin.companySlug, city);
  }
  for (const c of data.remoteCompanies) for (const role of c.roles) add(role, c.companyName, c.companySlug, null);
  const rows = [...byId.values()];
  for (const r of rows) r.searchText = `${r.role.title} ${r.companyName} ${r.cities.join(" ")}${r.remote ? " remote" : ""}`.toLowerCase();
  indexFor = { data, rows, byId, payRank: buildPayRanker(data.pins, data.remoteCompanies) };
  return indexFor;
}

/** The public page for a role: crawlable, no signup needed. */
export function rolePageUrl(companySlug: string, roleId: number, title: string): string {
  return `${SITE_URL}/companies/${companySlug}/${roleId}-${slugify(title) || "role"}/`;
}
export function companyPageUrl(companySlug: string): string {
  return `${SITE_URL}/companies/${companySlug}/`;
}

/** What an assistant gets back for each role in a list. */
function summary(row: Row, payRank: PayRanker, now: number) {
  const { role } = row;
  const since = openSince(roleDate(role), role.repostedFrom);
  const rank = payRank(role);
  return {
    id: role.id,
    title: role.title,
    company: row.companyName,
    company_slug: row.companySlug,
    level: SENIORITY_LABELS[role.seniority],
    locations: row.cities.length ? row.cities : null,
    remote: row.remote,
    salary: formatSalary(role.salaryMin, role.salaryMax, role.salaryCurrency, role.salaryPeriod) ?? "Not posted",
    pay_rank: rank ? `${payRankShort(rank)} for ${SENIORITY_LABELS[rank.seniority]} PM roles with a posted band` : null,
    open_for: daysOpenLabel(since, now),
    new_this_week: role.isNew,
    reposted: role.repostedFrom ? true : undefined,
    possible_ghost_job: ghostReason(role, now) ?? undefined,
    apply_url: role.url,
    tolara_url: rolePageUrl(row.companySlug, role.id, role.title),
  };
}

export interface SearchArgs {
  query?: string;
  company?: string;
  location?: string;
  levels?: Seniority[];
  min_salary?: number;
  remote?: "any" | "remote" | "in-office";
  industry?: string;
  posted_within_days?: number;
  new_only?: boolean;
  hide_ghost_jobs?: boolean;
  sort?: "newest" | "salary" | "company";
  limit?: number;
  offset?: number;
}

async function resolveCompanySlug(data: MapData, name: string): Promise<{ slug: string; name: string } | null> {
  const { rows } = index(data);
  const want = name.trim().toLowerCase();
  const wantSlug = slugify(name);
  const names = new Map<string, string>();
  for (const r of rows) names.set(r.companySlug, r.companyName);
  for (const [slug, n] of names) if (slug === want || slug === wantSlug || n.toLowerCase() === want) return { slug, name: n };
  // "capital one" -> "Capital One Financial": the first company whose name starts with it, then contains it.
  const starts = [...names].find(([, n]) => n.toLowerCase().startsWith(want));
  if (starts) return { slug: starts[0], name: starts[1] };
  const contains = [...names].find(([, n]) => n.toLowerCase().includes(want));
  return contains ? { slug: contains[0], name: contains[1] } : null;
}

function filtersFrom(args: SearchArgs): RoleFilters {
  const remote: RemoteMode = args.remote === "remote" ? "remote-only" : args.remote === "in-office" ? "office-only" : "all";
  return {
    ...EMPTY_FILTERS,
    seniority: new Set(args.levels ?? []),
    minSalary: args.min_salary ?? null,
    postedWithinDays: args.posted_within_days ?? null,
    newOnly: args.new_only ?? false,
    hideGhost: args.hide_ghost_jobs ?? false,
    remote,
    industry: args.industry ?? null,
  };
}

async function matchingRows(args: SearchArgs, now: number) {
  const data = await getMapData();
  const { rows, payRank } = index(data);
  let company: { slug: string; name: string } | null = null;
  if (args.company) {
    company = await resolveCompanySlug(data, args.company);
    if (!company) return { data, payRank, hits: [] as Row[], note: `No company named "${args.company}" has open PM roles on Tolara Scout right now.` };
  }
  const f = filtersFrom(args);
  const categoryOf = data.companyCategories ?? {};
  const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const where = (args.location ?? "").toLowerCase().trim();
  const hits = rows.filter((r) => {
    if (company && r.companySlug !== company.slug) return false;
    if (f.industry && (categoryOf[r.companySlug] ?? "other") !== f.industry) return false;
    if (!roleMatches(r.role, f, now)) return false;
    if (where) {
      const inCity = r.cities.some((c) => c.toLowerCase().includes(where));
      if (!inCity && !(where === "remote" && r.remote)) return false;
    }
    // Every word has to appear somewhere: "senior payments" finds senior payments roles.
    return words.every((w) => r.searchText.includes(w));
  });
  return { data, payRank, hits, note: company && company.name.toLowerCase() !== args.company!.trim().toLowerCase() ? `Showing ${company.name}.` : undefined };
}

export async function searchRoles(args: SearchArgs, now = Date.now()) {
  const { data, payRank, hits, note } = await matchingRows(args, now);
  const sort = args.sort ?? "newest";
  const top = (r: Row) => ((r.role.salaryPeriod ?? "year") === "year" ? (r.role.salaryMax ?? r.role.salaryMin ?? -1) : -1);
  const sorted = [...hits];
  if (sort === "salary") sorted.sort((a, b) => top(b) - top(a));
  else if (sort === "company") sorted.sort((a, b) => a.companyName.localeCompare(b.companyName) || a.role.title.localeCompare(b.role.title));
  else sorted.sort((a, b) => (roleDate(b.role) ?? 0) - (roleDate(a.role) ?? 0));
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const offset = Math.max(args.offset ?? 0, 0);
  return {
    total_matching: hits.length,
    showing: `${hits.length === 0 ? 0 : offset + 1}-${Math.min(offset + limit, hits.length)}`,
    note,
    data_updated: data.generatedAt,
    roles: sorted.slice(offset, offset + limit).map((r) => summary(r, payRank, now)),
  };
}

export async function getRole(roleId: number, now = Date.now()) {
  const data = await getMapData();
  const { byId, payRank, rows } = index(data);
  const row = byId.get(roleId);
  if (!row) {
    const closed = data.changes.closedRoles.find((r) => r.id === roleId);
    return closed
      ? { closed: true, message: `${closed.title} at ${closed.companyName} closed on ${closed.closedAt.slice(0, 10)}.` }
      : { closed: true, message: `Role ${roleId} isn't open on Tolara Scout. It may have closed, or the id may be wrong.` };
  }
  const file = await getCompanyFile(row.companySlug);
  const detail = file?.roles.find((r) => r.id === roleId);
  const others = rows.filter((r) => r.companySlug === row.companySlug && r.role.id !== roleId).length;
  return {
    ...summary(row, payRank, now),
    team: detail?.team ?? undefined,
    posted_location: row.role.location,
    what_the_role_focuses_on: detail?.focus?.bullets ?? undefined,
    other_open_pm_roles_at_company: others,
    company_page: companyPageUrl(row.companySlug),
  };
}

export async function getCompany(name: string, now = Date.now()) {
  const data = await getMapData();
  const company = await resolveCompanySlug(data, name);
  if (!company) return { found: false, message: `No company named "${name}" has open PM roles on Tolara Scout right now.` };
  const { rows, payRank } = index(data);
  const file = await getCompanyFile(company.slug);
  const roles = rows
    .filter((r) => r.companySlug === company.slug)
    .sort((a, b) => (roleDate(b.role) ?? 0) - (roleDate(a.role) ?? 0));
  const p = file?.intelligence?.profile ?? null;
  const weeks = file?.pulse?.weeks ?? [];
  const category = data.categories?.find((c) => c.id === data.companyCategories?.[company.slug])?.label ?? null;
  return {
    found: true,
    name: company.name,
    slug: company.slug,
    industry: category,
    about: p
      ? {
          description: p.description,
          founded: p.founded,
          headquarters: p.headquarters,
          employees: p.employees,
          website: p.website,
          linkedin: p.linkedinCompanyUrl,
        }
      : null,
    hiring_signals: file?.signals.map((s) => `${s.text} (${s.detail})`) ?? [],
    hiring_trend_by_week: weeks.slice(-8).map((w) => ({ week_of: w.start.slice(0, 10), open: w.open, opened: w.opened, closed: w.closed })),
    leaders: (file?.intelligence?.leaders ?? []).slice(0, 8).map((l) => ({ name: l.name, title: l.title, linkedin: l.linkedinUrl })),
    recent_news: (file?.intelligence?.news ?? []).slice(0, 5).map((n) => ({ title: n.title, source: n.source, date: n.publishedAt?.slice(0, 10) ?? null, url: n.url })),
    open_pm_roles: roles.length,
    roles: roles.map((r) => summary(r, payRank, now)),
    company_page: companyPageUrl(company.slug),
  };
}

export async function whatsNew(args: SearchArgs & { days?: number }, now = Date.now()) {
  const days = Math.min(Math.max(args.days ?? 1, 1), 7);
  const since = now - days * DAY;
  // "New" means first seen by our sync in the window, so a role that a board
  // backdated still counts as news the day it appears.
  const { data, payRank, hits, note } = await matchingRows({ ...args, posted_within_days: undefined }, now);
  const added = hits
    .filter((r) => Date.parse(r.role.firstSeenAt) >= since)
    .sort((a, b) => Date.parse(b.role.firstSeenAt) - Date.parse(a.role.firstSeenAt));
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 50);

  const company = args.company ? await resolveCompanySlug(data, args.company) : null;
  const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const where = (args.location ?? "").toLowerCase().trim();
  const closed = data.changes.closedRoles.filter((r) => {
    if (Date.parse(r.closedAt) < since) return false;
    if (company && r.companySlug !== company.slug) return false;
    if (where && where !== "remote" && ![r.city, r.state].filter(Boolean).join(", ").toLowerCase().includes(where)) return false;
    const text = `${r.title} ${r.companyName} ${r.city ?? ""} ${r.state ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return {
    window: `last ${days} day${days === 1 ? "" : "s"}`,
    last_sync: data.changes.lastSync?.finishedAt ?? data.generatedAt,
    note,
    new_roles_count: added.length,
    new_roles: added.slice(0, limit).map((r) => summary(r, payRank, now)),
    // The closed feed keeps title, company and office only, so level,
    // salary, remote and industry filters can't narrow it.
    closed_roles_note:
      args.levels?.length || args.min_salary || (args.remote && args.remote !== "any") || args.industry
        ? "Closed roles are filtered by company, keywords and location only."
        : undefined,
    closed_roles_count: closed.length,
    closed_roles: closed.slice(0, limit).map((r) => ({
      title: r.title,
      company: r.companyName,
      location: [r.city, r.state].filter(Boolean).join(", ") || null,
      closed: r.closedAt.slice(0, 10),
    })),
  };
}

export async function overview(now = Date.now()) {
  const data = await getMapData();
  const { rows } = index(data);
  const byLevel = Object.fromEntries(SENIORITY_TIERS.map((t) => [SENIORITY_LABELS[t], rows.filter((r) => r.role.seniority === t).length]));
  const cityCount = new Map<string, number>();
  for (const r of rows) for (const c of r.cities) cityCount.set(c, (cityCount.get(c) ?? 0) + 1);
  return {
    open_pm_roles: rows.length,
    companies: new Set(rows.map((r) => r.companySlug)).size,
    remote_roles: rows.filter((r) => r.remote).length,
    new_this_week: rows.filter((r) => r.role.isNew).length,
    possible_ghost_jobs: rows.filter((r) => ghostReason(r.role, now)).length,
    by_level: byLevel,
    top_cities: [...cityCount].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([city, n]) => ({ city, roles: n })),
    levels: SENIORITY_TIERS.map((t) => ({ id: t, label: SENIORITY_LABELS[t] })),
    industries: data.categories ?? [],
    data_updated: data.generatedAt,
    site: SITE_URL,
  };
}
