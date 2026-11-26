/**
 * Tolara Scout MCP server: open US product manager jobs, searchable
 * from Claude, Cursor or any MCP client. Runs on the user's own machine over
 * stdio and reads the public data the website publishes each night, so
 * there's no server or key involved.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SENIORITY_TIERS } from "../../src/types.js";
import { getCompany, getRole, overview, searchRoles, whatsNew } from "./tools.js";

const server = new McpServer(
  { name: "tolara-scout", version: "0.1.2" },
  {
    instructions:
      "Tolara Scout tracks open product manager roles at about 900 US companies, read daily from each company's own careers site. " +
      "It covers the companies it follows, not every PM job in the US, so say 'roles Tolara tracks' rather than 'all PM jobs'. " +
      "Use search_roles to find roles, get_role for one role's details, get_company for a company's roles and hiring trend, " +
      "and whats_new for roles that opened or closed recently (good for a daily digest). Salaries are only what the posting " +
      "states, never estimates. A 'possible ghost job' has been open 90+ days, or reposted and still open after 45. " +
      "Always give the user the apply_url or tolara_url for roles you mention.",
  },
);

const filterShape = {
  query: z.string().optional().describe('Words that must all appear in the title, company or city, e.g. "growth", "AI platform"'),
  company: z.string().optional().describe('A company name, e.g. "Stripe" or "Capital One"'),
  location: z.string().optional().describe('A city ("New York", "Austin, TX") or a state code or name ("VA", "Virginia"); "remote" matches remote roles'),
  levels: z.array(z.enum(SENIORITY_TIERS)).optional().describe("Seniority levels to include; leave out for all"),
  min_salary: z.number().int().positive().optional().describe("Yearly USD floor. Only roles that post a band can match, compared against the top of the band"),
  remote: z.enum(["any", "remote", "in-office"]).optional().describe("Remote roles only, in-office only, or any (default)"),
  industry: z.string().optional().describe("An industry id from tolara_overview, e.g. fintech"),
  new_only: z.boolean().optional().describe("Only roles first posted in the last week"),
  hide_ghost_jobs: z.boolean().optional().describe("Leave out possible ghost jobs"),
  limit: z.number().int().min(1).max(50).optional().describe("How many roles to return (default 20, max 50)"),
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "search_roles",
  {
    title: "Search PM jobs",
    description: "Search open US product manager roles by keyword, company, location, level, salary, remote, industry and posting age.",
    inputSchema: {
      ...filterShape,
      posted_within_days: z.number().int().positive().optional().describe("Only roles posted in the last N days"),
      sort: z.enum(["newest", "salary", "company"]).optional().describe("newest (default), salary (highest top of band first) or company A-Z"),
      offset: z.number().int().min(0).optional().describe("Skip this many results, for the next page"),
    },
    annotations: READ_ONLY,
  },
  async (args) => json(await searchRoles(args)),
);

server.registerTool(
  "get_role",
  {
    title: "Get a PM role",
    description: "One role's details: pay band and how it ranks for its level, how long it's been open, ghost-job flag, team, what the role focuses on, and links.",
    inputSchema: { role_id: z.number().int().positive().describe("The role id from search_roles") },
    annotations: READ_ONLY,
  },
  async ({ role_id }) => json(await getRole(role_id)),
);

server.registerTool(
  "get_company",
  {
    title: "Get a company",
    description: "A company's open PM roles, weekly hiring trend, hiring signals, leaders, recent news and basic profile.",
    inputSchema: { company: z.string().describe('Company name or slug, e.g. "Airbnb"') },
    annotations: READ_ONLY,
  },
  async ({ company }) => json(await getCompany(company)),
);

server.registerTool(
  "whats_new",
  {
    title: "What's new",
    description: "PM roles that opened, and roles that closed, in the last 1-7 days, with the same filters as search_roles. Made for daily digests.",
    inputSchema: {
      ...filterShape,
      days: z.number().int().min(1).max(7).optional().describe("How many days back to look (default 1, max 7)"),
    },
    annotations: READ_ONLY,
  },
  async (args) => json(await whatsNew(args)),
);

server.registerTool(
  "tolara_overview",
  {
    title: "Tolara Scout overview",
    description: "Totals for the PM roles Tolara tracks: roles by level, top cities, remote count, ghost jobs, and the industry ids search_roles accepts.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await overview()),
);

server.registerPrompt(
  "daily_pm_digest",
  {
    title: "Daily PM job digest",
    description: "New PM roles from the last day that fit what you're looking for.",
    argsSchema: { looking_for: z.string().describe('e.g. "Senior PM in New York or remote, $200k+, fintech or AI"') },
  },
  ({ looking_for }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Using Tolara Scout, find product manager roles that opened in the last day and fit: ${looking_for}. ` +
            "Call whats_new with matching filters (and tolara_overview first if you need an industry id). " +
            "List the best fits with company, title, location, salary and the apply link, flag any possible ghost jobs, " +
            "and mention roles that closed at companies I'd care about.",
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
