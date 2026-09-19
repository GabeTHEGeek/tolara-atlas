/**
 * db/init.ts
 * Runs schema.sql against the local SQLite database, creating it if it
 * doesn't exist. Safe to re-run — every CREATE is IF NOT EXISTS. Also
 * applies small additive migrations (new nullable columns) for databases
 * created before those columns existed, so an existing data/tolara.db
 * doesn't need to be deleted and rebuilt.
 *
 * CREATE TABLE IF NOT EXISTS can't widen a CHECK constraint on a table
 * that's already there, though -- when company_sources.platform's allowed
 * values grow (workday/paylocity/icims added alongside the original
 * greenhouse/ashby/lever/bamboohr/gem), an existing database keeps the OLD,
 * narrower constraint forever unless something rebuilds the table.
 * migrateCompanySourcesPlatformCheck below is that something: SQLite has no
 * ALTER TABLE ... DROP CONSTRAINT, so it renames the table, recreates it
 * from the current schema.sql definition, copies every row across, and
 * drops the renamed original, all inside one transaction.
 *
 * Usage: npm run db:init
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb, DB_PATH } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Migration {
  table: string;
  column: string;
  definition: string;
}

// Additive-only: new nullable/default-bearing columns for tables that may
// already exist from before this column was introduced. SQLite's ALTER
// TABLE ADD COLUMN can't be expressed as "IF NOT EXISTS", so this checks
// PRAGMA table_info first and skips columns that already exist.
const MIGRATIONS: Migration[] = [
  { table: "roles", column: "resolved_city", definition: "TEXT" },
  { table: "roles", column: "resolved_state", definition: "TEXT" },
  { table: "roles", column: "latitude", definition: "REAL" },
  { table: "roles", column: "longitude", definition: "REAL" },
  { table: "roles", column: "geocoded_at", definition: "TEXT" },
  { table: "role_locations", column: "is_remote", definition: "INTEGER NOT NULL DEFAULT 0" },
];

function applyMigrations(db: Database.Database) {
  for (const { table, column, definition } of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`  migrated: added ${table}.${column}`);
  }
}

// The full, current set of allowed company_sources.platform values, kept in
// sync with schema.sql's CHECK constraint by hand (there are only ever a
// handful of ATS adapters, so duplicating the list here beats parsing SQL).
const COMPANY_SOURCES_PLATFORMS = [
  "greenhouse",
  "ashby",
  "lever",
  "bamboohr",
  "workday",
  "paylocity",
  "icims",
  "tiktok",
  "apple",
  "gem",
] as const;

/**
 * Rebuilds company_sources in place if its existing CHECK constraint is
 * missing any current platform (detected by checking sqlite_master's stored
 * CREATE TABLE text rather than trying to introspect the CHECK expression
 * itself, which SQLite doesn't expose structurally). A no-op on a fresh
 * database, where schema.sql's CREATE TABLE IF NOT EXISTS above already
 * created the table with the up-to-date constraint.
 */
function migrateCompanySourcesPlatformCheck(db: Database.Database) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'company_sources'")
    .get() as { sql: string } | undefined;
  if (!row) return; // table doesn't exist yet -- schema.exec above will have just created it correctly

  const missing = COMPANY_SOURCES_PLATFORMS.filter((p) => !row.sql.includes(`'${p}'`));
  if (missing.length === 0) return;

  console.log(`  migrating: company_sources.platform CHECK constraint (adding ${missing.join(", ")})`);
  const platformList = COMPANY_SOURCES_PLATFORMS.map((p) => `'${p}'`).join(", ");
  db.exec(`
    BEGIN;
    ALTER TABLE company_sources RENAME TO company_sources_old;
    CREATE TABLE company_sources (
      id            INTEGER PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      platform      TEXT NOT NULL CHECK (platform IN (${platformList})),
      token         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('verified', 'unverified', 'failed')),
      last_checked  TEXT,
      notes         TEXT,
      UNIQUE (platform, token)
    );
    INSERT INTO company_sources (id, company_id, platform, token, status, last_checked, notes)
      SELECT id, company_id, platform, token, status, last_checked, notes FROM company_sources_old;
    DROP TABLE company_sources_old;
    CREATE INDEX IF NOT EXISTS company_sources_company_idx ON company_sources(company_id);
    CREATE INDEX IF NOT EXISTS company_sources_status_idx ON company_sources(status);
    COMMIT;
  `);
}

function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  const db = getDb();
  db.exec(schema);
  migrateCompanySourcesPlatformCheck(db);
  applyMigrations(db);

  console.log(`Initialized database at ${DB_PATH}`);
}

main();
