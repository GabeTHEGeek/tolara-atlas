# Tolara Scout

**Every open Product Manager job in the US, on one board and one map. Updated daily. With the pay.**

3,341 PM roles at 889 companies hiring right now, read straight from each
company's own careers site. No reposts, no "promoted" listings, no
"competitive salary": 72% of roles show the real pay band, and postings that
have sat open for months are flagged as possible ghosts.

[![Daily jobs sync](https://github.com/GabeTHEGeek/tolara-atlas/actions/workflows/sync.yml/badge.svg)](https://github.com/GabeTHEGeek/tolara-atlas/actions/workflows/sync.yml)
![Open PM roles](https://img.shields.io/badge/open%20PM%20roles-3%2C341-0b8a6e)
![Companies hiring](https://img.shields.io/badge/companies%20hiring-889-0b8a6e)
![Companies tracked](https://img.shields.io/badge/companies%20tracked-1%2C606-0b8a6e)
![Cities](https://img.shields.io/badge/cities-166-0b8a6e)
![With salary](https://img.shields.io/badge/with%20salary-72%25-0b8a6e)
![Median pay](https://img.shields.io/badge/median%20PM%20pay-%24210K-0b8a6e)
![Paid data](https://img.shields.io/badge/paid%20data-none-0b8a6e)

![The map: one pin per company office, sized by open PM roles](docs/screenshots/map.png)

> ⭐ **If this saves you an afternoon of tab-hopping, star the repo.** It's
> how other PMs find it.

---

## What's new

**Late November 2026: a match quiz, ghost-job flags and a landing page.**
The board now covers **3,341 roles at 889 companies in 166 cities.**

- 👋 **A landing page** at `#/welcome`. Every number on it (roles opened and
  closed this week, possible ghosts, pay by level, the newest roles for your
  level and city) is worked out from the same data file the board loads, so
  it updates with the daily sync. Visitors can sign up for the Monday email
  with their first name, last name and email, which go straight to Kit.
- 🎯 **A one-minute match quiz.** No resume needed: answer a few questions
  about your experience and what you want, and every role gets a match score.
  An animated ring next to each role shows how strong the match is.
- 👻 **Ghost-job flags.** Roles open 90+ days, or taken down, reposted and
  open 45+ days, are tagged *Possible ghost job*. One filter hides them all.
- 📋 **The job board is the home page.** The map is one click away at
  `#/map`, and old map links still work.
- 🌗 **A new light design,** with a switch for dark mode.
- 🏢 **170 more companies** from VC portfolio job boards (Accel, General
  Catalyst, Khosla, Insight, Thrive and 8VC), found with `npm run discover:vc`.
- 🎙️ **The voice copilot is now hidden by default.** Set `VITE_ENABLE_VOICE=1`
  in `.env.local` to turn it back on.

## Why this exists

Looking for a PM job means checking LinkedIn, Indeed and fifty careers pages,
and still not knowing:

- **Is this role still open?** Aggregators keep dead listings for months.
- **What does it pay?** Usually "competitive".
- **Who else is hiring in my city?** No job board shows you a map.
- **Am I a fit?** Keyword matching says yes to everything.

Tolara Scout answers all four. It reads 1,606 companies' own hiring pages
every day, so a role is here only while it's actually open, at the office
where it's actually based, with the pay band the company published. And when
a posting has been up so long it probably isn't a live search, it says so.

## Who's on it

**Big Tech:** Amazon · Google · Microsoft · Apple · Meta · NVIDIA · Netflix ·
TikTok · Oracle · Salesforce · Adobe · Workday · ServiceNow · HPE · Intel

**AI:** OpenAI · Anthropic · Perplexity · Scale AI · Glean · Sierra · Harvey ·
Mercor · Runway

**Fintech & banks:** JPMorgan Chase · Capital One · American Express ·
Mastercard · FanDuel · Stripe · Coinbase · Robinhood · Plaid · Ramp · Brex · Affirm

**Consumer:** Airbnb · Pinterest · Reddit · Roblox · Discord ·
Duolingo · DoorDash · Instacart · Lyft · Zillow · Expedia

**Software & data:** Snowflake · Databricks · Datadog · ServiceNow · Workday ·
Figma · Notion · Linear · Vercel · GitLab

…and 1,500 more. Don't see your company?
[Add it in one line](#add-a-company-in-one-line).

## PM pay, from real postings

Middle of the posted pay band, for the 2,388 roles that publish a yearly
band in USD:

| Level | Median |
|---|---|
| Associate / APM | **$106K** |
| Product Manager | **$200K** |
| Senior PM | **$209K** |
| Principal / Group PM | **$231K** |
| Director and above | **$239K** |

58% of banded roles pay $200K or more at the midpoint, and 152 pay $300K or
more. These are posted bands, not self-reported surveys.

**This week:** 427 roles added and 310 closed. The header shows what moved,
role by role. **485 open roles** are flagged as possible ghosts.

## What you get

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/job-board.png" alt="Job board with search, filters, salary bands and freshness tags"></td>
    <td width="50%"><img src="docs/screenshots/company.png" alt="A company's office on the map, listing its open roles with pay"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Job board</b>: search, filters, pay and freshness</sub></td>
    <td align="center"><sub><b>Company view</b>: every role at one office</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/role-prep.png" alt="Role-prep page with pay from the posting, leadership, company snapshot, hiring signals and news"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Role prep</b>: pay, leadership, company snapshot, hiring signals and news</sub></td>
  </tr>
</table>

<sub>Screenshots show the earlier dark design; the app now opens in light mode.</sub>

📋 **A job board first.** Search by title, company or city. Filter by level,
pay, industry, remote and posting date. Every role is tagged 🔥 Hot, ✨ New,
🧊 Aging or 🥶 Stale, so you apply while it's fresh.

🗺️ **And a map.** One pin per office, sized by open roles. See who's hiring
PMs in Seattle, Austin or New York at a glance.

👻 **Ghost-job flags.** Roles open 90+ days, or reposted and still open after
45, are flagged, with the reason. Hide them with one filter.

🏷️ **18 industries.** AI labs, fintech, banks, health, gaming, devtools,
security and more. Narrow the whole board to the space you want.

🎯 **Match scores.** Take the one-minute quiz, or score every role against
your resume, on domain, company stage, level, hard requirements, location
and pay. Each score comes with one line of evidence, so you can see why.
Sort by *Best match* and start at the top. Quiz answers and resumes stay on
your machine.

🧠 **Interview prep for every role.** Company snapshot, leadership, recent
news, hiring trend, and what the role will actually focus on, quoted from
the posting.

🤝 **People to reach.** Find the hiring manager and team for a role, ranked
by how close they are to it. Runs locally, only when you ask.

📈 **A change feed.** Every role opened and closed in the last week, so you
spot a team's hiring push before everyone else does.

👋 **A landing page** at `#/welcome` with live numbers and a signup for the
Monday email.

🎙️ **Talk to the map (optional, off by default).** *"Take me to New York."*
*"Only senior roles over $200K."* Answers come from the posting's own text,
not the model's memory.

## Built to be trusted

- **Straight from the source.** Every role links to the company's own
  posting. No middlemen, no reposts, no sponsored listings.
- **Pay is parsed, never guessed.** `$257K – $335K`, `208,000 USD - 327,750
  USD`, `$57–$70 per hour`. A 401(k) match is never mistaken for salary.
- **A blank beats a guess.** If a posting doesn't say it, neither do we.
- **Free data only.** The daily sync has no paid dependencies.
- **Your data stays local.** Resumes, quiz answers, match scores and
  contacts stay on your machine (in the browser or a gitignored folder) and
  are never committed.
- **No keys in the page.** AI provider keys are read only by the local dev
  server and never reach the browser.

## Run it yourself

Requires **Node 22**.

```bash
git clone https://github.com/GabeTHEGeek/tolara-atlas.git
cd tolara-atlas
npm install
npm run dev         # http://localhost:5173
```

The repo ships with the latest data, so the board and map work immediately:
no API keys and no sync needed.

**Fork it for your own search.** Take the match quiz in the app, or point the
matcher at your resume and the board sorts itself by fit:

```bash
npx tsx scripts/match-resume.ts .local/resume.txt
```

**Optional settings.** Copy `.env.example` to `.env` for server-side keys,
and put browser settings in `.env.local` (both are gitignored):

- `VITE_KIT_FORM_ID`: the Kit form that landing-page signups go to. It's a
  public form ID, not a secret. Never put an API key in a `VITE_` variable:
  Vite copies every one of them into the public page.
- `VITE_ENABLE_VOICE=1`: shows the voice copilot.
- A model key in `.env` (Gemini's free tier works) powers the voice copilot
  and People to reach. Six providers are supported, and switching is one line.

<details>
<summary>All scripts</summary>

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with the local APIs |
| `npm run sync` | Refresh every company's open roles |
| `npm run descriptions -- --minutes=20` | Fill in posting text and pay, time-budgeted |
| `npm run geocode` | Place each role on the map |
| `npm run prewarm` | Build company dossiers, time-budgeted |
| `npm run export` | Write the JSON the frontend reads |
| `npm run build` | Typecheck and build for production |
| `npm run discover` | Find more companies' job boards from community-maintained board lists |
| `npm run discover:a16z` | Find job boards from a16z's portfolio list |
| `npm run discover:vc` | Find job boards from VC portfolio job boards |
| `npm run find-people -- <role ids>` | Find people to reach for the roles you list |
| `npx tsx scripts/match-resume.ts <resume>` | Score every role against a resume |
| `npx tsx scripts/analyze-roles.ts` | Analyse new roles for the match quiz (run by hand) |

`scripts/analyze-roles.ts` calls DeepSeek, a paid model, so it's run by hand
and never as part of the daily sync, which stays free. Add `--dry-run` to see
what it would do without calling the model.

</details>

## Add a company in one line

Every tracked company is one row in
[`data/companies.csv`](data/companies.csv). If yours is on Greenhouse, Ashby,
Lever or Workday, it's a one-line pull request:

```csv
Your Company,yourcompany,greenhouse,verified,2026-11-14T00:00:00.000Z,Added by @you
```

The daily sync picks it up, and it's on the board the next morning.

## Roadmap

- [ ] Hosted version, no clone needed
- [x] Email signup on the landing page
- [ ] The Monday email: new roles that match your level and city
- [ ] More role families: engineering, design, data
- [ ] Hiring trends by company and city over time
- [ ] One-click resume upload for match scores

Ideas and pull requests are welcome. [Open an issue](https://github.com/GabeTHEGeek/tolara-atlas/issues).

## Under the hood

React, TypeScript and MapLibre on the front end; Node and SQLite behind it.
A GitHub Action refreshes the data every day and commits the result, so the
site itself is just static files.

```
server/
  ingestion/    careers-site connectors, pay parsing, geocoding, daily sync, company discovery
  enrichment/   company dossiers, leadership, news
  export/       static JSON the frontend reads
  agent/        voice copilot (hidden by default)
  match/        resume and quiz matching, scoring rubric
  contacts/     People to reach
src/
  components/   job board, map, filters, role pages, landing page, match quiz, change feed
```

---

<sub>Coverage figures are from the sync of November 24, 2026, and change every day.</sub>
