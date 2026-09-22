/**
 * agent/retrieval.ts
 * The data path the voice agent answers from.
 *
 * The static export deliberately drops each role's description (they run to
 * ~4KB and map-data.json loads on every visit), so the browser only ever
 * sees a role's title, salary, location and dates. That's enough to draw a
 * pin and nowhere near enough to answer "what are they actually hiring
 * for?" -- the answer to that is the posting's own text, which until now
 * never left SQLite.
 *
 * These lookups run server-side and hand the model the posting's words, so
 * an answer can be grounded in (and quoted from) the source rather than the
 * model's memory of the company. A role posted last week isn't in any
 * model's training data; this is the only place the real answer exists.
 */

import type Database from "better-sqlite3";

function sqliteToIso(ts: string): string {
  return new Date(`${ts.replace(" ", "T")}Z`).toISOString();
}

// Enough of a posting to answer questions about it without blowing the
// context on boilerplate. Descriptions average ~3.3KB; the tail is usually
// EEO text, benefits and legal.
const DESCRIPTION_CHARS = 2600;

export interface RoleContext {
  id: number;
  title: string;
  company: string;
  companySlug: string;
  team: string | null;
  location: string | null;
  offices: string[];
  salary: { min: number | null; max: number | null; currency: string | null; period: string | null } | null;
  postedAt: string | null;
  seniority: string | null;
  url: string | null;
  description: string | null;
  descriptionTruncated: boolean;
  descriptionNote: string | null;
}

export interface CompanyContext {
  name: string;
  slug: string;
  roleCount: number;
  offices: Array<{ city: string; state: string; roleCount: number }>;
  profile: { description: string | null; founded: number | null; headquarters: string | null; employees: number | null; industries: string[] } | null;
  /**
   * Whether we have ALREADY looked this company up, separate from whether
   * the lookup found anything.
   *
   * Without this the two are indistinguishable: a small company with no
   * Wikidata entry and no news looks exactly like one whose fetch hasn't
   * finished, so the agent says "still loading, try again shortly" forever
   * and the user keeps asking. "attempted" is what lets it say "we looked,
   * there's nothing published" and stop.
   */
  intelligence: { attempted: boolean; fetchedAt: string | null; hasDetail: boolean };
  leaders: Array<{ name: string; title: string }>;
  news: Array<{ title: string; source: string | null; publishedAt: string | null }>;
  roles: Array<{ id: number; title: string; location: string | null; seniority: string | null }>;
}

function trimDescription(raw: string | null): { text: string | null; truncated: boolean } {
  if (!raw) return { text: null, truncated: false };
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= DESCRIPTION_CHARS) return { text: cleaned, truncated: false };
  // Cut at a sentence boundary so the model isn't handed half a word.
  const window = cleaned.slice(0, DESCRIPTION_CHARS);
  const lastStop = window.lastIndexOf(". ");
  return { text: (lastStop > DESCRIPTION_CHARS * 0.6 ? window.slice(0, lastStop + 1) : window).trim(), truncated: true };
}

export function getRoleContext(db: Database.Database, roleId: number): RoleContext | null {
  const row = db
    .prepare(
      `SELECT r.id, r.title, r.category, r.location, r.description, r.url, r.posted_at,
              r.salary_min, r.salary_max, r.salary_currency, r.salary_period,
              c.name AS company, c.slug AS company_slug
       FROM roles r JOIN companies c ON c.id = r.company_id
       WHERE r.id = ? AND r.status = 'active'`,
    )
    .get(roleId) as
    | {
        id: number;
        title: string;
        category: string | null;
        location: string | null;
        description: string | null;
        url: string | null;
        posted_at: string | null;
        salary_min: number | null;
        salary_max: number | null;
        salary_currency: string | null;
        salary_period: string | null;
        company: string;
        company_slug: string;
      }
    | undefined;
  if (!row) return null;

  const offices = (
    db
      .prepare(`SELECT resolved_city, resolved_state FROM role_locations WHERE role_id = ?`)
      .all(roleId) as Array<{ resolved_city: string; resolved_state: string }>
  ).map((o) => `${o.resolved_city}, ${o.resolved_state}`);

  const { text, truncated } = trimDescription(row.description);
  const hasSalary = row.salary_min != null || row.salary_max != null;

  return {
    id: row.id,
    title: row.title.trim(),
    company: row.company,
    companySlug: row.company_slug,
    team: row.category?.trim() || null,
    location: row.location,
    offices,
    salary: hasSalary
      ? { min: row.salary_min, max: row.salary_max, currency: row.salary_currency, period: row.salary_period }
      : null,
    postedAt: row.posted_at,
    seniority: null,
    url: row.url,
    description: text,
    descriptionTruncated: truncated,
    // Several ATS adapters (Workday, Meta, BambooHR, Eightfold) only expose
    // a listing, not the posting body -- see the source adapters. Saying so
    // is more useful than reporting an empty field, and it points somewhere
    // that does have the answer.
    descriptionNote: text
      ? null
      : `This board doesn't publish posting text for ${row.company}, so there is no description to read from. Say that plainly and offer the original posting link.`,
  };
}

// Speech recognition spells digits out: "6Sense" comes back as "six sense",
// "8451" as "eighty four fifty one". Folding number words back to digits
// before comparing is what makes those names reachable by voice at all.
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

function foldNumberWords(s: string): string {
  return s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (w) => NUMBER_WORDS[w.toLowerCase()]);
}

/** Levenshtein, capped -- we only care whether it's within a small budget. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1; // whole row already over budget
    prev = row;
  }
  return prev[b.length];
}

/**
 * Resolves a spoken company name to one on the map. Speech recognition
 * mangles the short and odd ones, so this is deliberately forgiving:
 * exact, then digit-folded, then prefix, then contains, then a near-miss
 * within a small edit distance ("zocdock" -> Zocdoc). The caller is handed
 * the runners-up too, so the agent can ask rather than guess.
 */
export function findCompanies(db: Database.Database, spokenName: string, limit = 5): Array<{ id: number; name: string; slug: string; roleCount: number }> {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.slug, COUNT(r.id) AS roleCount
       FROM companies c JOIN roles r ON r.company_id = c.id AND r.status = 'active'
       GROUP BY c.id`,
    )
    .all() as Array<{ id: number; name: string; slug: string; roleCount: number }>;

  const needle = spokenName.trim().toLowerCase();
  if (!needle) return [];
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const squashed = squash(spokenName);
  const folded = squash(foldNumberWords(spokenName));
  // One edit for a short name, two for a longer one -- enough for a
  // mis-heard consonant, not so much that distinct companies collide.
  const budget = folded.length >= 8 ? 2 : folded.length >= 5 ? 1 : 0;

  const scored = rows
    .map((row) => {
      const name = row.name.toLowerCase();
      const rowSquashed = squash(row.name);
      let score = -1;
      if (name === needle) score = 0;
      else if (rowSquashed === squashed || rowSquashed === folded) score = 1;
      else if (name.startsWith(needle)) score = 2;
      else if (name.includes(needle)) score = 3;
      else if (squashed.length >= 3 && (rowSquashed.includes(squashed) || rowSquashed.includes(folded))) score = 4;
      else if (budget > 0 && editDistance(rowSquashed, folded, budget) <= budget) score = 5;
      return { row, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || b.row.roleCount - a.row.roleCount);

  return scored.slice(0, limit).map((s) => s.row);
}

export function getCompanyContext(db: Database.Database, companyId: number): CompanyContext | null {
  const company = db.prepare(`SELECT id, name, slug FROM companies WHERE id = ?`).get(companyId) as
    | { id: number; name: string; slug: string }
    | undefined;
  if (!company) return null;

  const roles = db
    .prepare(
      `SELECT r.id, r.title, r.location FROM roles r
       WHERE r.company_id = ? AND r.status = 'active'
       ORDER BY COALESCE(r.posted_at, r.first_seen_at) DESC`,
    )
    .all(companyId) as Array<{ id: number; title: string; location: string | null }>;

  const offices = db
    .prepare(
      `SELECT rl.resolved_city AS city, rl.resolved_state AS state, COUNT(DISTINCT rl.role_id) AS roleCount
       FROM role_locations rl JOIN roles r ON r.id = rl.role_id
       WHERE r.company_id = ? AND r.status = 'active' AND rl.is_remote = 0
       GROUP BY city, state ORDER BY roleCount DESC`,
    )
    .all(companyId) as Array<{ city: string; state: string; roleCount: number }>;

  const enrichment = (kind: string) => {
    const row = db
      .prepare(`SELECT data FROM company_enrichments WHERE company_id = ? AND kind = ?`)
      .get(companyId, kind) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  };

  // Rows existing at all means a lookup ran, whatever it returned.
  const attemptRow = db
    .prepare(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM company_enrichments WHERE company_id = ?`)
    .get(companyId) as { at: string | null; n: number };

  const profileRaw = enrichment("profile") as { found?: boolean; profile?: Record<string, unknown> } | null;
  const p = profileRaw?.found ? (profileRaw.profile as Record<string, unknown>) : null;
  const leaders = (enrichment("leadership") as Array<{ name: string; title: string }> | null) ?? [];
  const news = (enrichment("news") as Array<{ title: string; source: string | null; publishedAt: string | null }> | null) ?? [];

  // A profile row whose every useful field is null is not "detail" -- it's
  // usually just a logo and a domain from Clearbit.
  const hasDetail = Boolean(
    (p && (p.description || p.founded || p.employees || (p.industries as string[] | undefined)?.length)) ||
      leaders.length > 0 ||
      news.length > 0,
  );

  return {
    name: company.name,
    slug: company.slug,
    roleCount: roles.length,
    intelligence: {
      attempted: attemptRow.n > 0,
      fetchedAt: attemptRow.at ? sqliteToIso(attemptRow.at) : null,
      hasDetail,
    },
    offices,
    profile: p
      ? {
          description: (p.description as string) ?? null,
          founded: (p.founded as number) ?? null,
          headquarters: (p.headquarters as string) ?? null,
          employees: (p.employees as number) ?? null,
          industries: (p.industries as string[]) ?? [],
        }
      : null,
    leaders: leaders.map((l) => ({ name: l.name, title: l.title })),
    news: news.slice(0, 5).map((n) => ({ title: n.title, source: n.source, publishedAt: n.publishedAt })),
    roles: roles.map((r) => ({ id: r.id, title: r.title.trim(), location: r.location, seniority: null })),
  };
}

/**
 * Keyword search across titles and posting text -- the thing the site's own
 * search box can't do, since it only matches company names. Not semantic,
 * but it's free and it's what makes "find me roles about payments
 * infrastructure" return something real.
 */
export function searchRoles(
  db: Database.Database,
  query: string,
  limit = 12,
): Array<{ id: number; title: string; company: string; location: string | null; snippet: string | null }> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 2)
    .slice(0, 6);
  if (terms.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.location, r.description, c.name AS company
       FROM roles r JOIN companies c ON c.id = r.company_id
       WHERE r.status = 'active'`,
    )
    .all() as Array<{ id: number; title: string; location: string | null; description: string | null; company: string }>;

  const scored = rows
    .map((row) => {
      const title = row.title.toLowerCase();
      const body = (row.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 5;
        if (body.includes(term)) score += 1;
      }
      return { row, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ row }) => {
    const body = row.description ?? "";
    const first = terms.map((t) => body.toLowerCase().indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const snippet =
      first == null ? null : body.slice(Math.max(0, first - 90), first + 190).replace(/\s+/g, " ").trim();
    return { id: row.id, title: row.title.trim(), company: row.company, location: row.location, snippet };
  });
}

/**
 * Does the map actually have pins in this city?
 *
 * Without this the agent cheerfully announces "we're centered on Baltimore"
 * for a city with no roles in it: the tool call succeeds, the browser finds
 * nothing to fly to, and the words and the map disagree. Checking here --
 * where the data is -- means the model learns the truth before it speaks.
 */
export function findCities(
  db: Database.Database,
  spoken: string,
): { matches: Array<{ city: string; state: string; roleCount: number }>; sameState: Array<{ city: string; state: string; roleCount: number }> } {
  const rows = db
    .prepare(
      `SELECT rl.resolved_city AS city, rl.resolved_state AS state, COUNT(DISTINCT rl.role_id) AS roleCount
       FROM role_locations rl JOIN roles r ON r.id = rl.role_id
       WHERE r.status = 'active'
       GROUP BY city, state ORDER BY roleCount DESC`,
    )
    .all() as Array<{ city: string; state: string; roleCount: number }>;

  const needle = spoken.trim().toLowerCase().replace(/[^a-z ]/g, "");
  if (!needle) return { matches: [], sameState: [] };
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z ]/g, "");

  const matches = rows.filter((r) => {
    const c = norm(r.city);
    return c === needle || c.startsWith(needle) || needle.startsWith(c);
  });

  // Nothing in that city: offer what we do have in the same state, so the
  // answer is "I have Bethesda and Chevy Chase in Maryland" rather than a
  // flat no.
  let sameState: typeof rows = [];
  if (matches.length === 0) {
    const state = US_STATES[needle];
    if (state) sameState = rows.filter((r) => r.state.toUpperCase() === state).slice(0, 6);
  }
  return { matches, sameState };
}

// Only needed to answer "what do you have near there?" when a city misses.
const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
