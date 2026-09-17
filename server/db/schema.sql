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
  platform      TEXT NOT NULL CHECK (platform IN ('greenhouse', 'ashby', 'lever', 'bamboohr', 'gem')),
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
