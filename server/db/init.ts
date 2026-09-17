/**
 * db/init.ts
 * Runs schema.sql against the local SQLite database, creating it if it
 * doesn't exist. Safe to re-run — every statement is CREATE TABLE/INDEX IF
 * NOT EXISTS.
 *
 * Usage: npm run db:init
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDb, DB_PATH } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  const db = getDb();
  db.exec(schema);

  console.log(`Initialized database at ${DB_PATH}`);
}

main();
