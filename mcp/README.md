# Tolara Scout MCP

Search every open US product manager job from Claude, Cursor or any
[MCP](https://modelcontextprotocol.io) client. It reads
[Tolara Scout](https://gabethegeek.github.io/tolara-atlas/)'s public data,
refreshed every night from each company's own careers site: 3,000+ roles at
880+ companies, with posted pay bands and possible ghost jobs flagged.

It runs on your machine. There's no account, no key and nothing to pay for.

## Try asking

- "Find senior PM roles in New York paying $200K+, best paid first."
- "What is Capital One hiring PMs for, and is it hiring more or less than last month?"
- "Any new remote fintech PM roles since yesterday? Skip possible ghost jobs."
- "Compare the PM roles at Stripe and Ramp."

## Tools

| Tool | What it does |
|---|---|
| `search_roles` | Search by keywords, company, city or state, level, minimum salary, remote, industry and posting age; sort by newest, salary or company |
| `get_role` | One role: pay band and how it ranks for its level, how long it's been open, ghost-job flag, team, what the role focuses on, apply link |
| `get_company` | A company's open PM roles, weekly hiring trend, hiring signals, leaders, recent news and profile |
| `whats_new` | Roles that opened, and roles that closed, in the last 1–7 days |
| `tolara_overview` | Totals by level and city, and the industry ids `search_roles` accepts |

There's also a `daily_pm_digest` prompt. Pair it with your assistant's
scheduled tasks for a morning summary of new roles that fit you.

## Set it up

Until it's published on npm, run it from a checkout of this repo:

```bash
cd mcp && npm install && npm run build
```

**Claude Code**

```bash
claude mcp add tolara-scout -- node /path/to/tolara-atlas/mcp/dist/index.js
```

**Claude Desktop, Cursor and others** take the same command in their MCP
settings (`claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tolara-scout": {
      "command": "node",
      "args": ["/path/to/tolara-atlas/mcp/dist/index.js"]
    }
  }
}
```

Once it's on npm, the command becomes `npx -y tolara-scout-mcp`.

## Options

| Variable | Default | Use |
|---|---|---|
| `TOLARA_SITE_URL` | `https://gabethegeek.github.io/tolara-atlas` | Where to read the data from |
| `TOLARA_DATA_DIR` | (unset) | Read a local export instead, e.g. `../public/data` |

## Develop

```bash
npm run build && npm test   # starts the server and calls every tool
```

The tools reuse the site's own code for filters, ghost jobs and pay ranks
(`src/filters.ts`, `src/ghost.ts`, `src/payRank.ts`), so the assistant and
the board always agree on what matches.
