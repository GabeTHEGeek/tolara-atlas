/**
 * agent/tools.ts
 * What the agent can do, in two kinds.
 *
 * LOOKUP tools run here, against SQLite, and their results go back into the
 * model's context so the next thing it says is grounded in the posting's own
 * words rather than its memory of the company.
 *
 * ACTION tools don't run here at all -- they're handed to the browser, which
 * already knows how to perform them. The map, the filters and the role
 * drawer are all driven by state App.tsx owns, so the agent's action space
 * is simply the shape of that state: RoleFilters (src/filters.ts) and the
 * routes in src/router.ts. Nothing new had to be built for the agent to
 * drive the app; it fills in structs the UI already consumes.
 */

import type Database from "better-sqlite3";
import type { ToolSchema } from "./providers.js";
import { loadIntelligence } from "../enrichment/intelligence.js";
import { findCities, findCompanies, getCompanyContext, getRoleContext, searchRoles } from "./retrieval.js";
import { scoreResumeFit } from "./resumeFit.js";
import { seniorityOf } from "../export/roleFacets.js";

/**
 * Cold company profiles are never waited on.
 *
 * loadIntelligence fans out to Wikidata, Clearbit, EDGAR and Google News.
 * Measured against live companies it routinely takes longer than ten
 * seconds -- Reddit's profile landed only after a 7s budget had already
 * given up -- which is fine for a button press and unacceptable in the
 * middle of a spoken sentence.
 *
 * So the agent does what a person would: it presses the button and says
 * it's loading. When a role page is open, the browser runs the same
 * /api/intelligence request the "Load company intelligence" button runs,
 * spinner and all, and the cards fill in when they fill in. With no page
 * open there's nothing to spin, so the fetch is started here and left to
 * finish on its own -- warming the cache for the next question.
 */
// An explicit request waits this long before answering with whatever
// arrived. Ten seconds was defensible on paper and far too long to sit in
// silence mid-conversation; six covers the fetches that are going to make
// it, and the rest keep warming in the background for the next question.
const EXPLICIT_LOAD_BUDGET_MS = 6_000;

function warmInBackground(db: Database.Database, slug: string, roleId: number | null): void {
  void loadIntelligence(db, slug, roleId).catch(() => {
    // A source being unreachable is normal and already handled inside
    // loadIntelligence, which caches nothing on failure.
  });
}

export const SENIORITY_VALUES = ["associate", "mid", "senior", "principal", "director"] as const;

/** Tools whose results the browser performs. Returned to the client verbatim. */
export const ACTION_TOOLS = new Set([
  "flyToPlace",
  "zoomMap",
  "showCompany",
  "openRole",
  "setFilters",
  "clearFilters",
  // Emitted by lookupCompany when a profile is cold, and by the explicit
  // loadCompanyIntelligence tool: the open role page presses its own "Load
  // company intelligence" button rather than waiting to be clicked.
  "loadIntelligence",
]);

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "lookupCompany",
    description:
      "Look up a company on the map: its open roles, offices, profile, leadership and recent news. Use this before answering any question about a company. The name may be misheard, so pass what you heard and check the result.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Company name as heard, e.g. 'Airbnb'" } },
      required: ["name"],
    },
  },
  {
    name: "lookupRole",
    description:
      "Get the full detail of one role, INCLUDING the posting's own description of the work. Always call this before describing what a role involves or what the team is building — the description is the only source for that and it is not in your training data.",
    parameters: {
      type: "object",
      properties: { roleId: { type: "number", description: "The role's numeric id" } },
      required: ["roleId"],
    },
  },
  {
    name: "searchRoles",
    description:
      "Search open roles by keyword across titles and posting text, e.g. 'payments infrastructure', 'zero to one', 'developer tools'. Use for open-ended 'find me roles about X' questions.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
  },
  {
    name: "flyToPlace",
    description:
      "Move the map to a city or metro area, e.g. 'New York', 'Seattle', 'the Bay Area'. Use when the user asks to go somewhere or see a place.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. 'New York'" },
        state: { type: "string", description: "Two-letter state code if known, e.g. 'NY'" },
      },
      required: ["city"],
    },
  },
  {
    name: "showCompany",
    description:
      "Open a company's side panel on the map. Use for 'open the company panel', 'show me the company', 'open the company menu'. Omit companySlug to use the company whose role page is open.",
    parameters: {
      type: "object",
      properties: { companySlug: { type: "string", description: "Slug from lookupCompany. Omit to use the open role's company." } },
    },
  },
  {
    name: "openRole",
    description: "Open a specific role's page. Call lookupCompany or searchRoles first to get the role id and slug.",
    parameters: {
      type: "object",
      properties: {
        companySlug: { type: "string" },
        roleId: { type: "number" },
      },
      required: ["companySlug", "roleId"],
    },
  },
  {
    name: "setFilters",
    description:
      "Narrow the roles shown on the map. Only include the fields the user asked about; omitted fields are left as they are.",
    parameters: {
      type: "object",
      properties: {
        seniority: {
          type: "array",
          items: { type: "string", enum: [...SENIORITY_VALUES] },
          description: "Seniority tiers to show. Multiple tiers are combined (OR).",
        },
        minSalary: { type: "number", description: "Minimum salary in dollars, e.g. 200000. Only matches roles that publish a band." },
        postedWithinDays: { type: "number", description: "Only roles posted within this many days (7, 14 or 30)." },
        newOnly: { type: "boolean", description: "Only roles badged NEW." },
        remote: { type: "string", enum: ["all", "office-only", "remote-only"] },
      },
    },
  },
  {
    name: "zoomMap",
    description:
      "Zoom the map without moving it. 'in' and 'out' step by a level or two. Use 'reset' for 'zoom all the way out', 'show me the whole country', 'back to the US' — that frames every role on the map.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["in", "out", "reset"], description: "Which way to zoom, or reset to frame the whole US." },
        steps: { type: "number", description: "How many zoom levels for in/out, 1-4. Defaults to 1." },
      },
      required: ["direction"],
    },
  },
  {
    name: "clearFilters",
    description: "Remove all active filters and show every role again.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "scoreResumeFit",
    description:
      "Return a resume-fit score out of 100 for a role, with strengths and gaps. Use when the user asks to score their resume, whether they're a good fit, or their chances for a role.",
    parameters: {
      type: "object",
      properties: {
        roleId: { type: "number", description: "The role to score. Omit to use the role page that is open." },
      },
    },
  },
  {
    name: "loadCompanyIntelligence",
    description:
      "Load or refresh a company's profile, leadership and recent news — the same thing the 'Load company intelligence' button on a role page does. Use whenever the user asks to load, refresh or fetch company intelligence or a company profile, even if some of it is already cached.",
    parameters: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Slug from lookupCompany. Omit to use the company whose role page is open." },
      },
    },
  },
];

export interface ToolOutcome {
  // What goes back into the model's context.
  result: unknown;
  // Present for ACTION tools: what the browser should do.
  action?: { name: string; args: Record<string, unknown> };
}

/** Never looked this company up. Distinct from "looked and found nothing". */
function neverAttempted(context: ReturnType<typeof getCompanyContext>): boolean {
  return !context || !context.intelligence.attempted;
}

/**
 * What to tell the model about the state of a company's profile.
 *
 * The three cases have to be distinguishable or the conversation loops: a
 * company with no Wikidata entry and no news looks identical to one still
 * loading, and the agent keeps saying "try again shortly" about data that
 * is never going to arrive.
 */
function intelligenceNote(context: NonNullable<ReturnType<typeof getCompanyContext>>): string | null {
  if (!context.intelligence.attempted) {
    return (
      "No profile, leadership or news has been fetched for this company yet, and loading has just been started. " +
      "Answer from the roles and offices above, say their profile is loading, and invite them to ask again in a moment. " +
      "Do NOT describe their leadership, funding or news from your own knowledge."
    );
  }
  if (!context.intelligence.hasDetail) {
    return (
      "We ALREADY looked this company up and the public sources have nothing: no description, no leadership, no news. " +
      "This will NOT change by waiting. Say plainly that there's no public profile available for them and move on. " +
      "Do NOT say it is still loading, and do NOT ask the user to try again."
    );
  }
  return null;
}

export async function runTool(
  db: Database.Database,
  name: string,
  args: Record<string, unknown>,
  screen?: { openRoleId?: number | null; openCompanySlug?: string | null },
): Promise<ToolOutcome> {
  switch (name) {
    case "lookupCompany": {
      const matches = findCompanies(db, String(args.name ?? ""));
      if (matches.length === 0) {
        return { result: { found: false, note: `No company matching "${args.name}" has open roles on this map.` } };
      }
      const company = matches[0];
      const context = getCompanyContext(db, company.id);
      const untouched = neverAttempted(context);
      // Only ~3% of companies have a cached profile, because enrichment is
      // lazy -- it runs when someone clicks "Load company intelligence" on a
      // role page. Asking the agent about a company is that same request.
      const pageOpen = screen?.openCompanySlug === company.slug;
      if (untouched && !pageOpen) warmInBackground(db, company.slug, screen?.openRoleId ?? null);

      const note = context ? intelligenceNote(context) : null;
      return {
        result: {
          found: true,
          company: context,
          ...(note ? { note } : {}),
          // Speech mangles short names; letting the model see the runners-up
          // means it can ask "did you mean Ramp or Rampart?" instead of
          // confidently answering about the wrong company.
          otherMatches: matches.slice(1).map((m) => ({ name: m.name, slug: m.slug, roleCount: m.roleCount })),
        },
        // With the role page open, the browser presses the real button --
        // same endpoint, same spinner, same cards.
        action: untouched && pageOpen ? { name: "loadIntelligence", args: { companySlug: company.slug } } : undefined,
      };
    }
    case "lookupRole": {
      const role = getRoleContext(db, Number(args.roleId));
      return { result: role ? { found: true, role } : { found: false, note: "No active role with that id." } };
    }
    case "searchRoles": {
      const results = searchRoles(db, String(args.query ?? ""));
      return { result: { count: results.length, results } };
    }
    case "flyToPlace": {
      const spoken = String(args.city ?? "");
      const { matches, sameState } = findCities(db, spoken);
      if (matches.length === 0) {
        // Telling the model "dispatched" here is how it ends up announcing
        // "we're centered on Baltimore" over a map that never moved.
        return {
          result: {
            dispatched: false,
            note:
              `No open roles are mapped in "${spoken}", so the map cannot go there. Say so plainly -- do not claim to have moved.` +
              (sameState.length > 0
                ? ` Nearby in the same state: ${sameState.map((c) => `${c.city} (${c.roleCount})`).join(", ")}. Offer one of those.`
                : ""),
          },
        };
      }
      const best = matches[0];
      return {
        result: { dispatched: true, city: best.city, state: best.state, roleCount: best.roleCount },
        action: { name: "flyToPlace", args: { city: best.city, state: best.state } },
      };
    }
    case "scoreResumeFit": {
      const id = Number(args.roleId ?? screen?.openRoleId ?? NaN);
      if (!Number.isFinite(id)) {
        return { result: { ok: false, note: "No role specified and none is open. Ask which role they mean." } };
      }
      const role = getRoleContext(db, id);
      if (!role) return { result: { ok: false, note: "That role is no longer open." } };
      return { result: scoreResumeFit(role, seniorityOf(role.title)) };
    }
    case "loadCompanyIntelligence": {
      const slug = String(args.companySlug ?? screen?.openCompanySlug ?? "");
      if (!slug) {
        return { result: { ok: false, note: "No company specified and no role page is open. Ask which company." } };
      }
      // Unlike the implicit path, this one WAITS. The user asked for it and
      // expects a beat; answering from the snapshot taken before the fetch
      // finished is exactly how it ends up saying "nothing loaded" about
      // data that just appeared on screen.
      let loaded = null;
      try {
        await Promise.race([
          loadIntelligence(db, slug, screen?.openRoleId ?? null),
          new Promise((_, reject) => setTimeout(() => reject(new Error("budget")), EXPLICIT_LOAD_BUDGET_MS)),
        ]);
      } catch {
        // Ran past the budget; the fetch continues and the re-read below
        // simply reports whatever landed in time.
      }
      const company = db.prepare(`SELECT id FROM companies WHERE slug = ?`).get(slug) as { id: number } | undefined;
      loaded = company ? getCompanyContext(db, company.id) : null;
      const loadedNote = loaded ? intelligenceNote(loaded) : null;
      return {
        result: {
          ok: true,
          company: loaded,
          note:
            loadedNote ??
            "Their profile is loaded. Read out what's actually there -- description, leadership, recent news -- rather than saying it loaded.",
        },
        action: { name: "loadIntelligence", args: { companySlug: slug } },
      };
    }
    // Action tools: nothing happens here. The browser performs them and the
    // model is told they were dispatched, so it can describe what it did.
    case "zoomMap": {
      const raw = String(args.direction ?? "in");
      const direction = raw === "out" ? "out" : raw === "reset" ? "reset" : "in";
      const steps = Math.min(4, Math.max(1, Number(args.steps) || 1));
      return { result: { dispatched: true, direction, steps }, action: { name: "zoomMap", args: { direction, steps } } };
    }
    case "showCompany": {
      // Falls back to whatever is open, so "open the company panel" works
      // without the model having to look the slug up first.
      const slug = String(args.companySlug ?? screen?.openCompanySlug ?? "");
      if (!slug) {
        return { result: { dispatched: false, note: "No company named and none is open. Ask which company they mean." } };
      }
      return {
        result: { dispatched: true, companySlug: slug },
        // preferCurrentOffice tells the browser to open the office already
        // on screen rather than the company's biggest one -- jumping from
        // the role you're reading to headquarters is disorienting.
        action: { name, args: { ...args, companySlug: slug, preferCurrentOffice: true } },
      };
    }
    case "openRole":
    case "setFilters":
    case "clearFilters":
      return { result: { dispatched: true }, action: { name, args } };
    default:
      return { result: { error: `Unknown tool "${name}"` } };
  }
}
