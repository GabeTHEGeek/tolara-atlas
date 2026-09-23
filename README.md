# Tolara Atlas

An interactive map of open **Product Manager roles** in the US, built from the
companies' own applicant tracking systems. Every figure on a role page is
quoted from a labelled source and can be checked against the original posting —
because the page exists to prepare for interviews, and a confident invention is
worse than a blank.

[![Daily jobs sync](https://github.com/GabeTHEGeek/tolara-atlas/actions/workflows/sync.yml/badge.svg)](https://github.com/GabeTHEGeek/tolara-atlas/actions/workflows/sync.yml)
![Roles](https://img.shields.io/badge/roles-1%2C817-6fe0c4)
![Companies](https://img.shields.io/badge/companies-588-6fe0c4)
![Cities](https://img.shields.io/badge/cities-109-6fe0c4)
![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)
![MapLibre](https://img.shields.io/badge/MapLibre-4-295daa?logo=maplibre&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003b57?logo=sqlite&logoColor=white)

---

## What it does

**A map, not a list.** One pin per *(company, office)* — a company hiring in
three cities gets three pins, each listing only the roles actually posted
there. Same-city pins are spread into a small jittered cloud so neighbours
stay individually clickable.

**Filters that narrow everything at once.** Seniority, salary floor,
posted-within, new-only and remote. Filtering runs once before render, so the
map, the search box, the company panel and the unmapped list can never
disagree about which roles exist.

**A change feed.** The sync has always recorded when a role was first seen,
when it was last seen, and whether it has closed. The header reports what moved
in the last week and opens a panel listing every addition and every closure.

**Interview-prep dossiers.** Company profile, leadership and recent news,
plus what the role is likely focused on — taken verbatim from the posting's own
"What you'll do" list wherever the board publishes one.

**A voice copilot.** Talk to the map: *"take me to New York"*, *"only senior
roles over two hundred thousand"*, *"what would I actually be working on?"*.
It answers from the posting's own text, never from the model's memory.

## How the data gets there

```
ATS boards ──► sync ──► geocode ──► prewarm ──► export ──► static JSON ──► browser
(11 adapters)   SQLite   per-role    dossiers    map-data.json
                         lat/lng                 companies/*.json
```

Everything runs nightly in GitHub Actions and commits the result, so the site
itself is static files — no server required to browse it.

| Source | Used for |
|---|---|
| Greenhouse, Ashby, Lever, Workday, iCIMS, BambooHR, Paylocity, Eightfold, plus Apple / Meta / TikTok adapters | Roles, locations, salary bands |
| Wikidata | Company snapshot, leadership |
| SEC EDGAR | Headquarters and industry for public companies |
| Clearbit | Domain and logo where Wikidata has nothing |
| Google News RSS | Recent headlines |
| Our own sync history | Hiring signals, new/closed roles |

All free. No paid data dependencies — see [Design notes](#design-notes).

## Running it

Requires **Node 22** (the native `better-sqlite3` build is version-specific; on
another major version run `npm rebuild better-sqlite3`).

```bash
npm install
npm run db:init     # create/migrate data/tolara.db
npm run dev         # http://localhost:5173
```

The repo ships a populated database and exported JSON, so `npm run dev` works
immediately without a sync.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server, with the API middlewares mounted |
| `npm run sync` | Fetch every board, upsert roles, close stale ones |
| `npm run geocode` | Resolve each role's location to lat/lng |
| `npm run prewarm` | Fill the company-intelligence cache, time-budgeted |
| `npm run export` | Write `public/data/*.json` for the frontend |
| `npm run build` | Typecheck and build for production |
| `npx tsx scripts/test-salary-parsing.ts` | Table test for the salary parser |

## The voice copilot

Optional, and off unless a provider key is set. Copy `.env.example` to `.env`
and add one:

```bash
TOLARA_AGENT_PROVIDER=deepseek      # or gemini | openai | openrouter | nvidia | opencode
DEEPSEEK_API_KEY=...
```

Six providers sit behind a single OpenAI-shaped `/chat/completions` client, so
switching is one line and no code change.

**Two speech transports, also swappable:**

- `TOLARA_VOICE_TRANSPORT=webspeech` *(default)* — the browser's built-in
  recognition and synthesis. Free; no audio leaves the machine until the
  transcript reaches the local API.
- `TOLARA_VOICE_TRANSPORT=realtime` — OpenAI speech-to-speech over WebRTC.
  Barge-in, a real voice, and a genuine output waveform, billed per minute of
  audio. The API key stays on the server; the browser gets a short-lived
  ephemeral token.

**How it's grounded.** The agent's action space is the app's own state —
`RoleFilters` and the router — so it cannot reach anything a click couldn't.
Lookups run server-side against SQLite and hand the model the posting's actual
text, because these roles were posted too recently to be in any model's
training data. The prompt requires a lookup before describing any role, and
"I don't have that" is a valid answer.

## Design notes

**Free sources only.** The pipeline has no paid dependencies. The voice
copilot is the one place a paid API may be used, and it is opt-in.

**Verifiability over completeness.** A blank card beats a plausible guess. The
one deliberate exception is the resume-fit score, which is a demo: it is
deterministic per role so it doesn't contradict itself, and its supporting
detail is drawn from the posting, but the number itself is synthetic.

**Salary bands are parsed, not estimated.** Boards write `$257K – $335K`,
`$156.6K`, `$145,760`, `£194K`, `CA$140K`, `₹30L` and `$57 – $70 per hour`.
All of it is normalised to real figures with an explicit period; hourly rates
are never converted to annual, because the posting never said how many hours.

**The database is a build artifact.** `data/tolara.db` is committed so the
site works from a clone, but it is regenerated nightly and should be treated
as derived rather than authored.

## Layout

```
server/
  ingestion/    board adapters, salary parsing, geocoding, sync
  enrichment/   Wikidata, EDGAR, Clearbit, news, role focus, prewarm
  export/       static JSON the frontend reads
  agent/        voice copilot: tools, retrieval, providers, endpoints
  db/           schema and migrations
src/
  components/   map, panels, filter bar, change feed, voice dock
  voice/        transports (Web Speech, Realtime) and the agent hook
```

## Current coverage

**1,817 roles** across **588 companies** and **109 cities**, plus 128
companies whose roles have no resolvable office and are listed unmapped.
**1,178 roles publish a salary band.** By seniority: 855 senior, 551 mid,
176 director+, 159 principal/GPM, 76 associate.
