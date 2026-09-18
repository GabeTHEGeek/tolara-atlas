-- Tolara Atlas — SQLite schema
--
-- Design notes:
--   - companies/roles hold only what the ATS itself gives us for free
--     (name, location, title, salary if the posting states it). Nothing
--     here requires a second network call.
--   - company_sources/role_sources record WHERE a row came from (ATS
--     platform + token/id) so a re-sync knows what to re-fetch, and so
--     a single company can eventually have more than one board without
--     a schema change.
--   - company_enrichments/role_enrichments hold anything fetched from a
--     SEPARATE source (CEO lookup, news, LinkedIn) — kept apart from the
--     core tables on purpose so each enrichment type can have its own
--     refresh cadence and never gets re-fetched just because a role synced.
--   - sync_runs is an audit log: one row per ingestion pass, so a broken
--     run is visible instead of silently producing a stale map.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,      -- normalized, used for URLs/lookups
  website       TEXT,
  industry      TEXT,
  city          TEXT,
  state         TEXT,
  latitude      REAL,
  longitude     REAL,
  geocoded_at   TEXT,                      -- when lat/lng was last resolved; null = not yet geocoded
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS companies_location_idx ON companies(state, city);

-- Where a company's postings actually come from. A company could in theory
-- have more than one board (rare, but e.g. an acquired subsidiary keeping
-- its own); this table's shape doesn't block that even though v1 assumes one.
CREATE TABLE IF NOT EXISTS company_sources (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('greenhouse', 'ashby', 'lever', 'bamboohr', 'workday', 'paylocity', 'icims', 'gem')),
  token         TEXT NOT NULL,             -- the ATS board token/slug
  status        TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('verified', 'unverified', 'failed')),
  last_checked  TEXT,
  notes         TEXT,
  UNIQUE (platform, token)
);

CREATE INDEX IF NOT EXISTS company_sources_company_idx ON company_sources(company_id);
CREATE INDEX IF NOT EXISTS company_sources_status_idx ON company_sources(status);

CREATE TABLE IF NOT EXISTS roles (
  id              INTEGER PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_job_id   TEXT NOT NULL,           -- the ATS's own id for this posting
  platform        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  location        TEXT,
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_currency TEXT,
  remote_type     TEXT,
  category        TEXT,                    -- e.g. "Product", from the title filter that matched it
  url             TEXT,
  posted_at       TEXT,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  content_hash    TEXT NOT NULL,           -- hash of title+description+salary, detects real changes vs. just "still open"
  -- Per-ROLE geocoding (not per-company): a role's own location string is
  -- what gets placed on the map, so a company with offices in more than
  -- one city gets a pin per office instead of one company-wide guess.
  -- companies.city/state/latitude/longitude below are legacy from the v1
  -- company-level approach and are no longer used to plot pins.
  resolved_city   TEXT,
  resolved_state  TEXT,
  latitude        REAL,
  longitude       REAL,
  geocoded_at     TEXT,                    -- when this role's location was last resolved; null = not yet attempted
  UNIQUE (company_id, source_job_id)
);

CREATE INDEX IF NOT EXISTS roles_company_idx ON roles(company_id);
CREATE INDEX IF NOT EXISTS roles_status_idx ON roles(status);
CREATE INDEX IF NOT EXISTS roles_category_idx ON roles(category);

-- One row per (role, office it's actually open in). Most roles have
-- exactly one row here; a role posted as open in several offices at once
-- (e.g. "Menlo Park, CA; New York, NY; Washington, DC" as a single
-- listing) gets one row per office, so the map can place a pin at each
-- one instead of only the first city mentioned in the raw string.
-- roles.resolved_city/state/latitude/longitude (above) still hold the
-- FIRST location as a summary/back-compat column; this table is the full
-- set and what the map export actually reads pins from.
-- is_remote: 1 when this row doesn't come from a real office mentioned in
-- the posting -- the posting's location string had no resolvable city at
-- all (e.g. "Remote - USA", "Remote"), and this row instead pins the role
-- at the company's dominant office (the city where that company already
-- has the most other active roles), so a fully-remote posting still shows
-- up on the map somewhere findable instead of silently vanishing. 0 for
-- every row that came from an actual city in the posting's own location
-- string.
CREATE TABLE IF NOT EXISTS role_locations (
  id             INTEGER PRIMARY KEY,
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  raw_segment    TEXT,                    -- the geocoding query this row was resolved from
  resolved_city  TEXT NOT NULL,
  resolved_state TEXT NOT NULL,
  latitude       REAL NOT NULL,
  longitude      REAL NOT NULL,
  is_remote      INTEGER NOT NULL DEFAULT 0,
  geocoded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS role_locations_role_idx ON role_locations(role_id);

-- One row per (company, distinct raw location string) seen across that
-- company's FULL ATS board on the most recent sync -- every department,
-- not just the Product Manager postings stored in `roles`. sync.ts
-- captures this from the unfiltered board fetch, before the PM title
-- filter is applied, specifically so geocode.ts's remote-role fallback can
-- learn a company's real office footprint from its whole hiring activity
-- instead of just its 1-2 PM postings, which are often "Remote" with no
-- resolvable office at all even when the company clearly has real offices
-- (visible in its engineering/sales/support postings). posting_count is
-- how many of the board's current postings use that exact raw string, so
-- the fallback can weight a company's true office mix rather than treating
-- a one-off mention the same as its main hub. Wiped and rewritten wholesale
-- for a company on every sync run (not incremental) -- board composition
-- changes daily, and a stale tally would skew the fallback toward
-- yesterday's mix of openings.
CREATE TABLE IF NOT EXISTS company_board_locations (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_location   TEXT NOT NULL,
  posting_count  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS company_board_locations_company_idx ON company_board_locations(company_id);

-- Where a role's data literally came from (mostly redundant with roles.url,
-- but keeps a per-fact source/timestamp trail if role enrichment ever pulls
-- from more than the original posting).
CREATE TABLE IF NOT EXISTS role_sources (
  id          INTEGER PRIMARY KEY,
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,               -- 'posting', 'news', etc.
  source_url  TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS role_sources_role_idx ON role_sources(role_id);

-- One row per (company, enrichment kind). Each kind gets its own
-- refresh_after so CEO/leadership (changes rarely) and news (changes daily)
-- don't share a cadence.
CREATE TABLE IF NOT EXISTS company_enrichments (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('leadership', 'news', 'hiring_signal', 'profile')),
  data          TEXT NOT NULL,             -- JSON blob, shape depends on kind
  source_url    TEXT,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_after TEXT,                      -- null = never auto-refresh; else a timestamp the sync checks against
  UNIQUE (company_id, kind)
);

CREATE INDEX IF NOT EXISTS company_enrichments_company_idx ON company_enrichments(company_id);
CREATE INDEX IF NOT EXISTS company_enrichments_refresh_idx ON company_enrichments(refresh_after);

CREATE TABLE IF NOT EXISTS role_enrichments (
  id            INTEGER PRIMARY KEY,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('focus_summary')),
  data          TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (role_id, kind)
);

-- One row per ingestion pass. company_scope is null for a full run, or a
-- company_id for a manual single-company refresh (e.g. triggered from the UI).
CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  companies_synced INTEGER DEFAULT 0,
  roles_inserted  INTEGER DEFAULT 0,
  roles_updated   INTEGER DEFAULT 0,
  roles_closed    INTEGER DEFAULT 0,
  error           TEXT
);
