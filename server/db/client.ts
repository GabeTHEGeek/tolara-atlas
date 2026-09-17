/**
 * db/client.ts
 * Single shared better-sqlite3 connection. Local dev only for now — swap
 * this file out (or branch on an env var) if/when this moves to a hosted
 * SQLite-compatible service like Turso or Cloudflare D1.
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo-root/data/tolara.db, overridable for tests or alternate environments.
const DB_PATH = process.env.TOLARA_DB_PATH ?? path.join(__dirname, "..", "..", "data", "tolara.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export { DB_PATH };
