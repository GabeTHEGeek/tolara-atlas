/**
 * server/seo/generate.ts
 * Static, crawlable pages for search engines and AI answer engines, written
 * at build time from the same daily data the app reads.
 *
 * The app itself is one page with #-addresses, which search engines treat as
 * a single empty page. So the build also writes real pages, each with its
 * own address, title, description and structured data:
 *
 *   /jobs/                          hub: every city, level and company page
 *   /jobs/<city>/  /jobs/<level>/   and /jobs/<city>/<level>/ where there are roles
 *   /companies/<slug>/              a company's open PM roles
 *   /companies/<slug>/<id>-<title>/ one role, with schema.org JobPosting
 *                                   (what Google's job search reads)
 *   /pm-salaries/  /ghost-jobs/     answer pages: pay by level and city,
 *                                   and what a ghost job is
 *   sitemap.xml  robots.txt  llms.txt
 *
 * These pages are public on purpose: they show the facts of each posting
 * and link to the company's own application page. The full board (filters,
 * map, match scores) stays behind the signup, and everyone, crawler or
 * person, sees the same page here, so nothing is hidden from search.
 *
 * Every figure comes from src/landingStats.ts and src/seoFacts.ts, the same
 * code the landing page uses.
 */

import { ghostReason } from "../../src/ghost.js";
import { roleDate } from "../../src/filters.js";
import { landingRoles, METROS, LEVELS, type LandingRole, type MetroId } from "../../src/landingStats.js";
import { siteFacts, siteFaqs, type SiteFacts } from "../../src/seoFacts.js";
import type { MapData, Seniority } from "../../src/types.js";

export interface CompanyRole {
  id: number;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  url: string;
  postedAt: string | null;
  firstSeenAt: string;
  repostedFrom: string | null;
  seniority: Seniority;
  offices: Array<{ city: string; state: string; isRemote: boolean }>;
  focus: { bullets: string[] } | null;
}

export interface CompanyFile {
  company: { name: string; slug: string };
  roles: CompanyRole[];
}

export interface SeoInput {
  data: MapData;
  companies: Map<string, CompanyFile>;
  siteUrl: string; // e.g. https://gabethegeek.github.io/tolara-atlas (no trailing slash)
}

const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString("en-US");
const k = (n: number) => `$${Math.round(n / 1000)}K`;

export const METRO_SLUG: Record<Exclude<MetroId, "all">, string> = {
  remote: "remote",
  bay: "san-francisco-bay-area",
  nyc: "new-york",
  seattle: "seattle",
  la: "los-angeles",
  boston: "boston",
  texas: "austin-dallas",
  chicago: "chicago",
  dc: "washington-dc",
};

export const LEVEL_SLUG: Record<Seniority, { slug: string; noun: string }> = {
  associate: { slug: "associate-product-manager", noun: "Associate Product Manager" },
  mid: { slug: "product-manager", noun: "Product Manager" },
  senior: { slug: "senior-product-manager", noun: "Senior Product Manager" },
  principal: { slug: "principal-product-manager", noun: "Staff & Principal Product Manager" },
  director: { slug: "director-of-product", noun: "Director of Product" },
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON for a <script type="application/ld+json">, safe inside HTML. */
function ld(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

function band(r: Pick<CompanyRole, "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryPeriod">): string | null {
  const { salaryMin: lo, salaryMax: hi } = r;
  if (lo == null && hi == null) return null;
  const per = r.salaryPeriod ?? "year";
  const usd = (r.salaryCurrency ?? "USD") === "USD";
  const f = (n: number) => (per === "year" ? `${Math.round(n / 1000)}K` : n.toLocaleString("en-US"));
  const sym = usd ? "$" : `${r.salaryCurrency} `;
  const range = lo != null && hi != null && lo !== hi ? `${sym}${f(lo)} – ${sym}${f(hi)}` : `${sym}${f((lo ?? hi)!)}`;
  return per === "year" ? range : `${range} per ${per}`;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Nov 13, 2026", for people; isoDay is for structured data. */
function niceDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function placeLabel(offices: CompanyRole["offices"], location: string | null): string {
  const real = offices.filter((o) => !o.isRemote);
  const names = [...new Set(real.map((o) => `${o.city}, ${o.state}`))];
  const remote = offices.some((o) => o.isRemote) || /remote/i.test(location ?? "");
  if (names.length === 0) return remote ? "Remote (US)" : (location ?? "United States");
  const shown = names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
  return remote ? `${shown} or remote` : shown;
}

/* ------------------------------------------------------------------ layout */

interface PageMeta {
  path: string; // "/jobs/seattle/" -- site-relative, leading and trailing slash
  title: string;
  description: string;
  crumbs?: Array<[string, string]>; // [label, path]
  jsonld?: unknown[];
  noindex?: boolean;
}

const CSS = `
:root{--bg:#fff;--surface:#f6f9fc;--ink:#0a2540;--muted:#4b5d74;--line:#e3e8ee;--accent:#0b8a6e;--accent-ink:#fff;--money:#0c7a3d;--violet:#6d4fe0;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#070d14;--surface:#0d1621;--ink:#e8eef5;--muted:#9aabbf;--line:#1f2c3a;--accent:#3fd6b1;--accent-ink:#04261d;--money:#6fe3a0;--violet:#a993ff;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 Geist,Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:3px}
.w{max-width:960px;margin:0 auto;padding-left:max(24px,env(safe-area-inset-left,0px));padding-right:max(24px,env(safe-area-inset-right,0px))}
header{border-bottom:1px solid var(--line)}header .w{display:flex;align-items:center;gap:16px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;color:var(--ink);text-decoration:none;letter-spacing:-.02em}
.mark{width:28px;height:28px;border-radius:8px;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-weight:800;font-size:15px}
.cta{margin-left:auto;display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:600;font-size:14.5px;text-decoration:none;white-space:nowrap}
nav.crumbs{font-size:13.5px;color:var(--muted);padding-top:28px;display:flex;flex-wrap:wrap;gap:6px}
nav.crumbs a{color:var(--muted);text-decoration:none}nav.crumbs a:hover{color:var(--ink);text-decoration:underline}
nav.crumbs .sep{opacity:.5}
main{padding-block:20px 72px}
h1{font-size:clamp(32px,5vw,48px);line-height:1.08;letter-spacing:-.035em;margin:0 0 16px;text-wrap:balance}
h2{font-size:23px;line-height:1.25;letter-spacing:-.02em;margin:56px 0 18px;text-wrap:balance}
p{margin:0 0 16px}
.lede{font-size:18.5px;line-height:1.6;color:var(--muted);max-width:40em;margin:0 0 28px}
.prose{max-width:42em}.prose ul{margin:4px 0 20px;padding-left:22px}.prose li{margin:0 0 10px;padding-left:4px}.prose li::marker{color:var(--accent)}
.note{font-size:14.5px;color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:0 0 28px}
.fact{background:var(--surface);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:4px}
.fact b{font-size:24px;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.fact span{font-size:13.5px;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 8px}
.btn{display:inline-flex;align-items:center;height:48px;padding:0 24px;border-radius:999px;font-weight:600;text-decoration:none;white-space:nowrap}
.btn-dark{background:var(--ink);color:var(--bg)}.btn-soft{background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
ul.roles{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
ul.roles li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;padding:16px 0;border-bottom:1px solid var(--line)}
ul.roles a.t{font-weight:600;line-height:1.4;color:var(--ink);text-decoration:none}ul.roles a.t:hover{color:var(--accent);text-decoration:underline}
ul.roles .m{grid-row:2;font-size:14px;line-height:1.5;color:var(--muted)}
ul.roles .p{grid-row:1/3;grid-column:2;align-self:center;font-weight:600;font-size:14.5px;font-variant-numeric:tabular-nums;color:var(--money);white-space:nowrap}
.more{margin-top:20px}
.tag{display:inline-block;vertical-align:2px;font-size:12px;font-weight:600;line-height:1.6;padding:0 8px;border-radius:999px;color:var(--violet);background:color-mix(in srgb,var(--violet) 14%,transparent);margin-left:8px}
.links{display:flex;flex-wrap:wrap;gap:10px;margin:0;padding:0;list-style:none}
.links a{display:inline-block;padding:8px 14px;border-radius:999px;background:var(--surface);color:var(--ink);text-decoration:none;font-size:14.5px}.links a:hover{box-shadow:inset 0 0 0 1px var(--accent)}
.tw{overflow-x:auto;margin:0 0 8px}table{border-collapse:collapse;width:100%;font-size:15.5px}
th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;font-size:13.5px}td.n{font-variant-numeric:tabular-nums}
.box{background:var(--surface);border-radius:16px;padding:22px 24px;margin:0 0 8px;max-width:42em}.box p{margin:8px 0 0}
.ghost{background:color-mix(in srgb,var(--violet) 10%,transparent);border-radius:14px;padding:16px 20px;margin:0 0 28px;max-width:42em}
footer{border-top:1px solid var(--line);padding-block:32px 48px;font-size:14px;line-height:1.7;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px}footer a{color:var(--muted)}
@media (max-width:600px){.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fact{padding:14px 16px}.fact b{font-size:19px}h2{margin-top:44px}.lede{font-size:17px}.btn{flex:1 1 auto;justify-content:center}ul.roles li{grid-template-columns:minmax(0,1fr)}ul.roles .p{grid-row:auto;grid-column:auto;align-self:start}}
`;

export class Site {
  readonly base: string; // "/tolara-atlas" or ""
  constructor(readonly url: string) {
    this.base = new URL(url + "/").pathname.replace(/\/$/, "");
  }
  href(path: string): string {
    return this.base + path;
  }
  abs(path: string): string {
    return this.url + path;
  }
  app(hash = "#/welcome"): string {
    return `${this.base}/${hash}`;
  }

  page(meta: PageMeta, body: string, facts: SiteFacts): string {
    const canonical = this.abs(meta.path);
    const crumbs = meta.crumbs ?? [];
    const crumbLd =
      crumbs.length > 0
        ? [
            {
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              itemListElement: [["Tolara Scout", "/"], ...crumbs].map(([name, p], i) => ({
                "@type": "ListItem",
                position: i + 1,
                name,
                item: this.abs(p),
              })),
            },
          ]
        : [];
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(canonical)}">
${meta.noindex ? '<meta name="robots" content="noindex">\n' : ""}<meta property="og:type" content="website">
<meta property="og:site_name" content="Tolara Scout">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(this.abs("/og.png"))}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${this.href("/favicon.svg")}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap">
<meta name="theme-color" content="#0a2540">
<style>${CSS}</style>
${[...crumbLd, ...(meta.jsonld ?? [])].map(ld).join("\n")}
</head>
<body>
<header><div class="w"><a class="brand" href="${this.href("/")}"><span class="mark">T</span>Tolara Scout</a><a class="cta" href="${this.app()}">Get free access</a></div></header>
<div class="w">
${
  crumbs.length
    ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="${this.href("/")}">Home</a>${crumbs
        .map(([label, p], i) => (i === crumbs.length - 1 ? `<span class="sep">›</span><span>${esc(label)}</span>` : `<span class="sep">›</span><a href="${this.href(p)}">${esc(label)}</a>`))
        .join("")}</nav>`
    : ""
}
<main>
${body}
</main>
</div>
<footer><div class="w">Tolara Scout · ${fmt(facts.openRoles)} open US product manager roles at ${fmt(facts.companies)} companies, updated daily. Last update ${esc(facts.updatedLabel)}.
<nav aria-label="Site"><a href="${this.href("/jobs/")}">All PM jobs</a><a href="${this.href("/pm-salaries/")}">PM salaries</a><a href="${this.href("/ghost-jobs/")}">Ghost jobs</a><a href="${this.app()}">Open the board</a></nav></div></footer>
</body>
</html>
`;
  }
}

/* ------------------------------------------------------------------ data */

interface RoleEntry {
  role: CompanyRole;
  company: { name: string; slug: string };
  path: string;
  ghost: string | null;
  posted: number;
  metros: Set<MetroId>;
}

function buildRoles(input: SeoInput, landing: LandingRole[], now: number): RoleEntry[] {
  const metrosById = new Map(landing.map((r) => [r.role.id, r.metros]));
  const out: RoleEntry[] = [];
  const seen = new Set<number>();
  for (const file of input.companies.values()) {
    for (const role of file.roles) {
      if (seen.has(role.id) || !metrosById.has(role.id)) continue; // only roles open on the board today
      seen.add(role.id);
      out.push({
        role,
        company: file.company,
        path: `/companies/${file.company.slug}/${role.id}-${slugify(role.title) || "role"}/`,
        ghost: ghostReason(role, now),
        posted: roleDate(role) ?? Date.parse(role.firstSeenAt),
        metros: metrosById.get(role.id) ?? new Set(),
      });
    }
  }
  return out.sort((a, b) => b.posted - a.posted);
}

/** The company's own website, from the logo URL the export already has. */
function companySite(logo: string | undefined): string | null {
  const m = logo?.match(/^https:\/\/icons\.duckduckgo\.com\/ip3\/([a-z0-9.-]+)\.ico$/i);
  return m ? `https://${m[1]}` : null;
}

function roleList(site: Site, roles: RoleEntry[], limit = 200): string {
  if (roles.length === 0) return "<p>No open roles right now.</p>";
  return `<ul class="roles">${roles
    .slice(0, limit)
    .map((r) => {
      const pay = band(r.role);
      return `<li><a class="t" href="${site.href(r.path)}">${esc(r.role.title)}</a>${r.ghost ? '<span class="tag">Possible ghost</span>' : ""}<span class="m">${esc(r.company.name)} · ${esc(placeLabel(r.role.offices, r.role.location))} · posted ${niceDay(r.posted)}</span>${pay ? `<span class="p">${esc(pay)}</span>` : ""}</li>`;
    })
    .join("")}</ul>${roles.length > limit ? `<p class="more">And ${fmt(roles.length - limit)} more on <a href="${site.app()}">the full board</a>.</p>` : ""}`;
}

function itemList(site: Site, roles: RoleEntry[], limit = 200) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    numberOfItems: roles.length,
    itemListElement: roles.slice(0, limit).map((r, i) => ({ "@type": "ListItem", position: i + 1, url: site.abs(r.path), name: r.role.title })),
  };
}

function medianTop(roles: RoleEntry[]): number | null {
  const tops = roles
    .filter((r) => (r.role.salaryPeriod ?? "year") === "year" && (r.role.salaryCurrency ?? "USD") === "USD")
    .map((r) => r.role.salaryMax ?? r.role.salaryMin)
    .filter((n): n is number => n != null && n >= 30_000 && n <= 2_000_000)
    .sort((a, b) => a - b);
  if (!tops.length) return null;
  const m = tops.length >> 1;
  return tops.length % 2 ? tops[m] : (tops[m - 1] + tops[m]) / 2;
}

/* ------------------------------------------------------------------ pages */

function rolePage(
  site: Site,
  r: RoleEntry,
  facts: SiteFacts,
  logos: Record<string, string>,
  siblings: RoleEntry[],
  generated: number,
  repeated: boolean,
): [string, string] {
  const { role, company } = r;
  const where = placeLabel(role.offices, role.location);
  const pay = band(role);
  const level = LEVEL_SLUG[role.seniority];
  const bullets = role.focus?.bullets?.slice(0, 5) ?? [];
  const remote = role.offices.some((o) => o.isRemote) || /remote/i.test(role.location ?? "");
  const offices = role.offices.filter((o) => !o.isRemote);
  // A company sometimes posts the same title in the same city more than once;
  // its job number tells the pages apart.
  const title = `${role.title} at ${company.name}${offices[0] ? ` (${offices[0].city}, ${offices[0].state})` : remote ? " (Remote)" : ""}${repeated ? ` (job ${role.id})` : ""}`;
  const description = `${company.name} is hiring a ${role.title} in ${where}.${pay ? ` Posted pay: ${pay}.` : ""} Posted ${niceDay(r.posted)}. See the role and apply on ${company.name}'s careers site.`;

  const summaryHtml = `<p><strong>${esc(company.name)}</strong> is hiring a <strong>${esc(role.title)}</strong> in ${esc(where)}.${pay ? ` The posted pay band is <strong>${esc(pay)}</strong>.` : " The posting doesn't list pay."}</p>${
    bullets.length ? `<p>What the role focuses on, from the posting:</p><ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""
  }`;
  // Structured data gets the application address as text; the page shows it as the buttons above.
  const pageSummary = summaryHtml;
  const schemaSummary = `${summaryHtml}<p>Apply on ${esc(company.name)}'s careers site: ${esc(role.url)}</p>`;

  const site_ = companySite(logos[company.slug]);
  const salaryUnit = { year: "YEAR", hour: "HOUR", month: "MONTH", week: "WEEK", day: "DAY" }[role.salaryPeriod ?? "year"] ?? "YEAR";
  const posting: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: role.title,
    description: schemaSummary,
    datePosted: isoDay(r.posted),
    validThrough: isoDay(generated + 14 * DAY),
    url: site.abs(r.path),
    identifier: { "@type": "PropertyValue", name: company.name, value: String(role.id) },
    directApply: false,
    hiringOrganization: {
      "@type": "Organization",
      name: company.name,
      ...(site_ ? { sameAs: site_ } : {}),
      ...(logos[company.slug] ? { logo: logos[company.slug] } : {}),
    },
  };
  if (offices.length) {
    posting.jobLocation = offices.map((o) => ({
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: o.city, addressRegion: o.state, addressCountry: "US" },
    }));
  }
  if (remote) {
    posting.jobLocationType = "TELECOMMUTE";
    posting.applicantLocationRequirements = { "@type": "Country", name: "USA" };
  }
  if (role.salaryMin != null || role.salaryMax != null) {
    posting.baseSalary = {
      "@type": "MonetaryAmount",
      currency: role.salaryCurrency ?? "USD",
      value: {
        "@type": "QuantitativeValue",
        ...(role.salaryMin != null ? { minValue: role.salaryMin } : {}),
        ...(role.salaryMax != null ? { maxValue: role.salaryMax } : {}),
        unitText: salaryUnit,
      },
    };
  }

  const others = siblings.filter((s) => s.role.id !== role.id).slice(0, 10);
  const body = `<h1>${esc(role.title)}</h1>
<p class="lede">${esc(company.name)} · ${esc(where)} · ${esc(level.noun)} level</p>
<div class="facts">
<div class="fact"><b>${pay ? esc(pay) : "Not posted"}</b><span>Posted pay</span></div>
<div class="fact"><b>${niceDay(r.posted)}</b><span>Posted</span></div>
<div class="fact"><b>${Math.max(0, Math.floor((generated - r.posted) / DAY))} days</b><span>Open so far</span></div>
</div>
${r.ghost ? `<div class="ghost"><strong>Possible ghost job.</strong> ${esc(r.ghost)}</div>` : ""}
<div class="actions"><a class="btn btn-dark" href="${esc(role.url)}" rel="nofollow noopener" target="_blank">Apply on ${esc(company.name)}'s site</a><a class="btn btn-soft" href="${site.app(`#/company/${company.slug}/role/${role.id}`)}">See pay rank and your match score</a></div>
<h2>About this role</h2>
<div class="prose">
${pageSummary}
<p class="note">Still open on ${esc(company.name)}'s careers site as of ${esc(facts.updatedLabel)}. Tolara Scout checks it every day.</p>
</div>
${others.length ? `<h2>More PM roles at ${esc(company.name)}</h2>${roleList(site, others, 10)}` : ""}`;

  return [
    r.path,
    site.page(
      {
        path: r.path,
        title: `${title} | Tolara Scout`,
        description,
        crumbs: [
          ["Companies", "/jobs/#companies"],
          [company.name, `/companies/${company.slug}/`],
          [role.title, r.path],
        ],
        // A possible ghost job still gets its page, but isn't offered to job
        // search as a live opening.
        jsonld: r.ghost ? [] : [posting],
      },
      body,
      facts,
    ),
  ];
}

function companyPage(site: Site, slug: string, name: string, roles: RoleEntry[], facts: SiteFacts, logos: Record<string, string>): [string, string] {
  const path = `/companies/${slug}/`;
  const med = medianTop(roles);
  const cities = [...new Set(roles.flatMap((r) => r.role.offices.filter((o) => !o.isRemote).map((o) => `${o.city}, ${o.state}`)))];
  const ghosts = roles.filter((r) => r.ghost).length;
  const site_ = companySite(logos[slug]);
  const n = roles.length;
  const body = `<h1>${esc(name)} product manager jobs</h1>
<p class="lede">${esc(name)} has ${fmt(n)} open product manager role${n === 1 ? "" : "s"} in the US${cities.length ? `, in ${esc(cities.slice(0, 5).join(", "))}${cities.length > 5 ? ` and ${cities.length - 5} more cities` : ""}` : ""}.${med ? ` The typical top of the posted pay band is ${k(med)}.` : ""}</p>
<div class="facts">
<div class="fact"><b>${fmt(n)}</b><span>Open PM roles</span></div>
<div class="fact"><b>${med ? k(med) : "—"}</b><span>Typical top of pay band</span></div>
<div class="fact"><b>${fmt(ghosts)}</b><span>Possible ghost jobs</span></div>
</div>
${roleList(site, roles)}`;
  return [
    path,
    site.page(
      {
        path,
        title: `${name} Product Manager Jobs (${fmt(n)} open) | Tolara Scout`,
        description: `${fmt(n)} open product manager roles at ${name}${cities[0] ? ` in ${cities.slice(0, 3).join(", ")}` : ""}${med ? `, typical pay up to ${k(med)}` : ""}. Updated daily from ${name}'s careers site.`,
        crumbs: [
          ["Companies", "/jobs/#companies"],
          [name, path],
        ],
        jsonld: [
          { "@context": "https://schema.org", "@type": "Organization", name, ...(site_ ? { url: site_ } : {}), ...(logos[slug] ? { logo: logos[slug] } : {}) },
          itemList(site, roles),
        ],
      },
      body,
      facts,
    ),
  ];
}

function listingPage(
  site: Site,
  path: string,
  heading: string,
  noun: string, // completes "N open ___ at M companies", e.g. "Senior Product Manager roles in Seattle"
  roles: RoleEntry[],
  facts: SiteFacts,
  crumbs: Array<[string, string]>,
  related: string,
): [string, string] {
  const live = roles.filter((r) => !r.ghost);
  const med = medianTop(roles);
  const fresh = roles.filter((r) => Date.parse(facts.updated) - r.posted <= facts.windowDays * DAY).length;
  const companies = new Set(roles.map((r) => r.company.slug)).size;
  const body = `<h1>${esc(heading)}</h1>
<p class="lede">${fmt(roles.length)} open ${esc(noun)} at ${fmt(companies)} companies, as of ${esc(facts.updatedLabel)}.${med ? ` The typical top of the posted pay band is ${k(med)}.` : ""} Newest first, straight from each company's careers site.</p>
<div class="facts">
<div class="fact"><b>${fmt(roles.length)}</b><span>Open roles</span></div>
<div class="fact"><b>+${fmt(fresh)}</b><span>Posted in the last ${facts.windowDays} days</span></div>
<div class="fact"><b>${med ? k(med) : "—"}</b><span>Typical top of pay band</span></div>
<div class="fact"><b>${fmt(roles.length - live.length)}</b><span>Possible ghost jobs</span></div>
</div>
${roleList(site, roles)}
${related}`;
  return [
    path,
    site.page(
      {
        path,
        title: `${heading} (${fmt(roles.length)} open) | Tolara Scout`,
        description: `${fmt(roles.length)} open ${noun} at ${fmt(companies)} companies${med ? `, typical pay up to ${k(med)}` : ""}. Updated daily from company careers sites, with possible ghost jobs flagged.`,
        crumbs,
        jsonld: [itemList(site, roles)],
      },
      body,
      facts,
    ),
  ];
}

/* ------------------------------------------------------------------ entry */

export interface SeoOutput {
  files: Map<string, string>; // output-relative path -> contents
  homeHead: string; // extra <head> tags for index.html
  homeBody: string; // pre-rendered content for #root
  pageCount: number;
}

export function generateSeo(input: SeoInput): SeoOutput {
  const site = new Site(input.siteUrl.replace(/\/$/, ""));
  const generated = Date.parse(input.data.generatedAt);
  const facts = siteFacts(input.data, generated);
  const faqs = siteFaqs(facts);
  const landing = landingRoles(input.data, generated);
  const roles = buildRoles(input, landing, generated);
  const logos = input.data.logos ?? {};
  const files = new Map<string, string>();
  const urls: Array<{ path: string; lastmod: string; priority: string }> = [];
  const today = isoDay(generated);
  const put = ([path, html]: [string, string], priority: string, lastmod = today) => {
    files.set(`${path.replace(/^\//, "")}index.html`, html);
    urls.push({ path, lastmod, priority });
  };

  const byCompany = new Map<string, RoleEntry[]>();
  for (const r of roles) {
    const list = byCompany.get(r.company.slug) ?? [];
    list.push(r);
    byCompany.set(r.company.slug, list);
  }

  // Roles and companies.
  const titleKey = (r: RoleEntry) => `${r.company.slug}|${r.role.title}|${r.role.offices[0]?.city ?? ""}`;
  const keyCount = new Map<string, number>();
  for (const r of roles) keyCount.set(titleKey(r), (keyCount.get(titleKey(r)) ?? 0) + 1);
  for (const r of roles) {
    const repeated = (keyCount.get(titleKey(r)) ?? 0) > 1;
    put(rolePage(site, r, facts, logos, byCompany.get(r.company.slug) ?? [], generated, repeated), "0.6", isoDay(r.posted));
  }
  for (const [slug, list] of byCompany) put(companyPage(site, slug, list[0].company.name, list, facts, logos), "0.7");

  // Cities, levels, and city x level.
  const metroLabel = new Map(METROS.map(([id, label]) => [id, label]));
  const levelPages: string[] = [];
  const cityPages: string[] = [];
  for (const [lvl] of LEVELS) {
    if (lvl === "all") continue;
    const list = roles.filter((r) => r.role.seniority === lvl);
    if (list.length < 3) continue;
    const { slug, noun } = LEVEL_SLUG[lvl];
    const path = `/jobs/${slug}/`;
    levelPages.push(`<a href="${site.href(path)}">${esc(noun)} jobs</a>`);
    put(listingPage(site, path, `${noun} jobs in the US`, `${noun} roles in the US`, list, facts, [["PM jobs", "/jobs/"], [`${noun} jobs`, path]], ""), "0.8");
  }
  for (const [metro, mslug] of Object.entries(METRO_SLUG) as Array<[Exclude<MetroId, "all">, string]>) {
    const list = roles.filter((r) => r.metros.has(metro));
    if (list.length < 3) continue;
    const label = metroLabel.get(metro)!;
    const where = metro === "remote" ? "Remote product manager jobs" : `Product manager jobs in ${label}`;
    const path = `/jobs/${mslug}/`;
    cityPages.push(`<a href="${site.href(path)}">${esc(metro === "remote" ? "Remote" : label)}</a>`);
    const sub: string[] = [];
    for (const [lvl] of LEVELS) {
      if (lvl === "all") continue;
      const sl = list.filter((r) => r.role.seniority === lvl);
      if (sl.length < 3) continue;
      const { slug, noun } = LEVEL_SLUG[lvl as Seniority];
      const spath = `/jobs/${mslug}/${slug}/`;
      const sh = metro === "remote" ? `Remote ${noun} jobs` : `${noun} jobs in ${label}`;
      sub.push(`<a href="${site.href(spath)}">${esc(noun)}</a>`);
      put(
        listingPage(site, spath, sh, metro === "remote" ? `remote ${noun} roles` : `${noun} roles in ${label}`, sl, facts, [["PM jobs", "/jobs/"], [metro === "remote" ? "Remote" : label, path], [noun, spath]], ""),
        "0.7",
      );
    }
    put(
      listingPage(site, path, where, metro === "remote" ? "remote product manager roles" : `product manager roles in ${label}`, list, facts, [["PM jobs", "/jobs/"], [metro === "remote" ? "Remote" : label, path]], sub.length ? `<h2>By level</h2><ul class="links">${sub.map((a) => `<li>${a}</li>`).join("")}</ul>` : ""),
      "0.8",
    );
  }

  // The hub.
  const companyLinks = [...byCompany.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([slug, list]) => `<li><a href="${site.href(`/companies/${slug}/`)}">${esc(list[0].company.name)} (${list.length})</a></li>`)
    .join("");
  put(
    [
      "/jobs/",
      site.page(
        {
          path: "/jobs/",
          title: `Product Manager Jobs in the US (${fmt(facts.openRoles)} open) | Tolara Scout`,
          description: `${fmt(facts.openRoles)} open product manager jobs at ${fmt(facts.companies)} US companies, by city, level and company. Pay bands where posted, ghost jobs flagged, updated daily.`,
          crumbs: [["PM jobs", "/jobs/"]],
          jsonld: [itemList(site, roles, 100)],
        },
        `<h1>Product manager jobs in the US</h1>
<p class="lede">${fmt(facts.openRoles)} open PM roles at ${fmt(facts.companies)} companies, read daily from each company's careers site. Last update ${esc(facts.updatedLabel)}.</p>
<h2>By city</h2><ul class="links">${cityPages.map((a) => `<li>${a}</li>`).join("")}</ul>
<h2>By level</h2><ul class="links">${levelPages.map((a) => `<li>${a}</li>`).join("")}</ul>
<h2>Newest roles</h2>${roleList(site, roles, 50)}
<h2 id="companies">By company</h2><ul class="links">${companyLinks}</ul>`,
        facts,
      ),
    ],
    "0.9",
  );

  // Answer pages.
  put(salaryPage(site, roles, facts), "0.9");
  put(ghostPage(site, roles, facts, faqs), "0.8");

  // Home: extra head tags and a pre-rendered body React replaces on load.
  const homeLd = [
    { "@context": "https://schema.org", "@type": "WebSite", name: "Tolara Scout", url: site.abs("/") },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Tolara Scout",
      url: site.abs("/"),
      logo: site.abs("/favicon.svg"),
    },
    {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: "Open product manager jobs in the US",
      description: `Every open product manager role at ${fmt(facts.companies)} US companies, read daily from each company's careers site, with posted pay bands, office locations, level and days open.`,
      url: site.abs("/jobs/"),
      dateModified: facts.updated,
      isAccessibleForFree: true,
      creator: { "@type": "Organization", name: "Tolara Scout" },
      spatialCoverage: "United States",
      variableMeasured: ["job title", "company", "location", "posted pay band", "seniority", "date posted"],
      distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: site.abs("/data/map-data.json") }],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
  const homeDescription = `Every open product manager job in the US on one free board and map: ${fmt(facts.openRoles)} roles at ${fmt(facts.companies)} companies, with posted pay bands, match scores and ghost jobs flagged. Updated daily.`;
  const homeTitle = `Tolara Scout: ${fmt(facts.openRoles)} Product Manager Jobs in the US, Updated Daily`;
  const homeHead = [
    `<meta name="description" content="${esc(homeDescription)}">`,
    `<link rel="canonical" href="${esc(site.abs("/"))}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Tolara Scout">`,
    `<meta property="og:title" content="${esc(homeTitle)}">`,
    `<meta property="og:description" content="${esc(homeDescription)}">`,
    `<meta property="og:url" content="${esc(site.abs("/"))}">`,
    `<meta property="og:image" content="${esc(site.abs("/og.png"))}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="theme-color" content="#0a2540">`,
    ...homeLd.map(ld),
  ].join("\n    ");
  const homeBody = `<main style="max-width:960px;margin:0 auto;padding:32px 20px;font-family:system-ui,sans-serif">
<h1>Every real PM job. None of the ghosts.</h1>
<p>A free map and job board of all ${fmt(facts.openRoles)} open product manager roles in the US, at ${fmt(facts.companies)} companies, read daily from each company's own careers site. See the pay band when it's posted, a match score for your experience, and a flag on postings that have sat open for months.</p>
<ul>
<li>+${fmt(facts.addedThisWeek)} PM roles opened in the last ${facts.windowDays} days, −${fmt(facts.closedThisWeek)} taken down</li>
<li>${fmt(facts.ghostRoles)} open 90+ days or reposted: possible ghost jobs</li>
<li>Typical top of the posted pay band: ${facts.payByLevel.map((p) => `${esc(p.label)} ${k(p.pay)}`).join(", ")}</li>
</ul>
<p><a href="${site.href("/jobs/")}">Browse PM jobs by city, level and company</a> · <a href="${site.href("/pm-salaries/")}">PM salaries</a> · <a href="${site.href("/ghost-jobs/")}">Ghost jobs</a></p>
<h2>Questions</h2>
<dl>${faqs.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
</main>`;
  urls.unshift({ path: "/", lastmod: today, priority: "1.0" });

  files.set("sitemap.xml", sitemap(site, urls));
  files.set("robots.txt", robots(site));
  files.set("llms.txt", llmsTxt(site, facts, faqs, cityPages.length));

  return { files, homeHead, homeBody, pageCount: urls.length };
}

function salaryPage(site: Site, roles: RoleEntry[], facts: SiteFacts): [string, string] {
  const path = "/pm-salaries/";
  const rows = facts.payByLevel
    .map((p) => `<tr><td>${esc(p.label)}</td><td class="n">${k(p.pay)}</td><td class="n">${fmt(p.sample)}</td></tr>`)
    .join("");
  const metroRows = (Object.entries(METRO_SLUG) as Array<[Exclude<MetroId, "all">, string]>)
    .map(([id, slug]) => {
      const list = roles.filter((r) => r.metros.has(id));
      const med = medianTop(list);
      const label = METROS.find(([m]) => m === id)![1];
      return med && list.length >= 10 ? `<tr><td><a href="${site.href(`/jobs/${slug}/`)}">${esc(label)}</a></td><td class="n">${k(med)}</td><td class="n">${fmt(list.length)}</td></tr>` : "";
    })
    .join("");
  const top = facts.payByLevel.at(-1);
  const answer = `The typical top of the posted pay band for an open US product manager role is ${facts.medianPayTop ? k(facts.medianPayTop) : "not known"} as of ${facts.updatedLabel}, rising from ${facts.payByLevel[0] ? k(facts.payByLevel[0].pay) : "?"} for associate PMs to ${top ? k(top.pay) : "?"} at director level.`;
  const body = `<h1>Product manager salaries in the US</h1>
<p class="lede">${esc(answer)}</p>
<div class="box"><strong>How this is measured.</strong><p>From the pay bands companies publish in their own job postings (${Math.round(facts.withPayShare * 100)}% of open PM roles list one), not from surveys. Each figure is the median of the top of the band, for yearly US-dollar bands. Updated daily.</p></div>
<h2>By level</h2>
<div class="tw"><table><thead><tr><th>Level</th><th>Typical top of band</th><th>Roles with a band</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>By city</h2>
<div class="tw"><table><thead><tr><th>City</th><th>Typical top of band</th><th>Open roles</th></tr></thead><tbody>${metroRows}</tbody></table></div>
<p><a href="${site.app()}">Open the board</a> to see where any one role's pay ranks among others at the same level.</p>`;
  return [
    path,
    site.page(
      {
        path,
        title: `Product Manager Salary in the US (${new Date(facts.updated).getUTCFullYear()}): ${facts.medianPayTop ? k(facts.medianPayTop) : ""} Typical Top of Band | Tolara Scout`,
        description: answer,
        crumbs: [["PM salaries", path]],
        jsonld: [
          {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: "Product manager salaries in the US",
            description: answer,
            dateModified: facts.updated,
            author: { "@type": "Organization", name: "Tolara Scout" },
            mainEntityOfPage: site.abs(path),
          },
        ],
      },
      body,
      facts,
    ),
  ];
}

function ghostPage(site: Site, roles: RoleEntry[], facts: SiteFacts, faqs: Array<{ q: string; a: string }>): [string, string] {
  const path = "/ghost-jobs/";
  const ghostFaq = faqs.find((f) => f.q.startsWith("What is a ghost job"))!;
  const longest = roles
    .filter((r) => r.ghost)
    .sort((a, b) => a.posted - b.posted)
    .slice(0, 10);
  const body = `<h1>Ghost jobs: what they are and how to spot them</h1>
<p class="lede">${esc(ghostFaq.a)}</p>
<div class="facts">
<div class="fact"><b>${fmt(facts.ghostRoles)}</b><span>Possible ghost PM jobs today</span></div>
<div class="fact"><b>${Math.round(facts.ghostShare * 100)}%</b><span>Of open US PM roles</span></div>
</div>
<h2>How Tolara Scout flags them</h2>
<ul><li>Open <strong>90 days or more</strong>, counted from the original posting, or</li><li>Taken down and <strong>reposted</strong>, and still open after <strong>45 days</strong>.</li></ul>
<p>It's a timing signal, not proof: some searches really are slow. That's why the label says "possible", and why the board lets you hide them with one filter rather than hiding them for you.</p>
<h2>The longest-open PM postings right now</h2>
${roleList(site, longest, 10)}`;
  return [
    path,
    site.page(
      {
        path,
        title: `Ghost Jobs: ${fmt(facts.ghostRoles)} Possible Ghost PM Postings Today | Tolara Scout`,
        description: ghostFaq.a,
        crumbs: [["Ghost jobs", path]],
        jsonld: [
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [{ "@type": "Question", name: ghostFaq.q, acceptedAnswer: { "@type": "Answer", text: ghostFaq.a } }],
          },
        ],
      },
      body,
      facts,
    ),
  ];
}

function sitemap(site: Site, urls: Array<{ path: string; lastmod: string; priority: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(site.abs(u.path))}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>
`;
}

function robots(site: Site): string {
  // Answer engines are welcome: being quoted by them is the point.
  return `User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: ${site.abs("/sitemap.xml")}
`;
}

function llmsTxt(site: Site, facts: SiteFacts, faqs: Array<{ q: string; a: string }>, cities: number): string {
  return `# Tolara Scout

> A free job board and map of every open product manager (PM) job in the US: ${fmt(facts.openRoles)} roles at ${fmt(facts.companies)} companies as of ${facts.updatedLabel}, read daily from each company's own careers site, with posted pay bands, seniority, office locations and possible ghost jobs flagged.

Figures below are from the ${facts.updatedLabel} update and change daily.

## Key facts

- Open US product manager roles: ${fmt(facts.openRoles)} at ${fmt(facts.companies)} companies
- Opened in the last ${facts.windowDays} days: ${fmt(facts.addedThisWeek)}; taken down: ${fmt(facts.closedThisWeek)}
- Roles that list a pay band: ${Math.round(facts.withPayShare * 100)}%
- Typical top of the posted pay band (median, yearly USD): ${facts.medianPayTop ? k(facts.medianPayTop) : "n/a"}
- By level: ${facts.payByLevel.map((p) => `${p.label} ${k(p.pay)}`).join("; ")}
- Possible ghost jobs (open 90+ days, or reposted and open 45+ days): ${fmt(facts.ghostRoles)} (${Math.round(facts.ghostShare * 100)}%)
- Most open roles: ${[...facts.metros].sort((a, b) => b.open - a.open).slice(0, 5).map((m) => `${m.label} ${fmt(m.open)}`).join("; ")}
- Companies with the most open PM roles: ${facts.topCompanies.slice(0, 8).map((c) => `${c.name} (${c.open})`).join(", ")}

## Questions

${faqs.map((f) => `### ${f.q}\n\n${f.a}`).join("\n\n")}

## Pages

- [All PM jobs, by city, level and company](${site.abs("/jobs/")}): ${cities} city pages, 5 level pages, a page per company and per role
- [Product manager salaries](${site.abs("/pm-salaries/")}): pay by level and city from posted bands
- [Ghost jobs](${site.abs("/ghost-jobs/")}): how possible ghost postings are flagged
- [The data as JSON](${site.abs("/data/map-data.json")}): every open role with pay, level and location
- [Sitemap](${site.abs("/sitemap.xml")})
`;
}
