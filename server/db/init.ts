/**
 * db/init.ts
 * Runs schema.sql against the local SQLite database, creating it if it
 * doesn't exist. Safe to re-run — every CREATE is IF NOT EXISTS. Also
 * applies small additive migrations (new nullable columns) for databases
 * created before those columns existed, so an existing data/tolara.db
 * doesn't need to be deleted and rebuilt.
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
];

function applyMigrations(db: Database.Database) {
  for (const { table, column, definition } of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`  migrated: added ${table}.${column}`);
  }
}

function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  const db = getDb();
  db.exec(schema);
  applyMigrations(db);

  console.log(`Initialized database at ${DB_PATH}`);
}

main();
