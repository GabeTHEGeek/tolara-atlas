/**
 * scripts/smoke-test-db.ts
 * One-off smoke test for the schema + upsert logic in sync.ts, using
 * synthetic data instead of real ATS network calls — this sandbox's egress
 * allowlist blocks boards-api.greenhouse.io / api.ashbyhq.com / api.lever.co,
 * so this is how the DB layer gets verified here. Delete once the real
 * sync has been run successfully outside this sandbox.
 */
import { getDb } from "../server/db/client.js";
import { createHash } from "node:crypto";

const db = getDb();

function contentHash(title: string, description: string, salary: string): string {
  return createHash("sha256").update(`${title}\n${description}\n${salary}`).digest("hex");
}

const company = db
  .prepare(`INSERT INTO companies (name, slug) VALUES (?, ?) ON CONFLICT (slug) DO UPDATE SET updated_at = datetime('now') RETURNING id`)
  .get("Cobalt Robotics", "cobalt-robotics") as { id: number };

db.prepare(
  `INSERT INTO company_sources (company_id, platform, token, status, last_checked) VALUES (?, 'greenhouse', 'cobaltrobotics', 'verified', datetime('now'))
   ON CONFLICT (platform, token) DO UPDATE SET status = 'verified', last_checked = datetime('now')`,
).run(company.id);

const hash = contentHash("Senior Product Manager", "Own the robotics platform roadmap.", "USD 150,000 - 190,000");

db.prepare(
  `INSERT INTO roles (company_id, source_job_id, platform, title, description, location, salary_min, salary_max, salary_currency, category, url, posted_at, content_hash, status)
   VALUES (?, 'gh_999', 'greenhouse', 'Senior Product Manager', 'Own the robotics platform roadmap.', 'Remote (US)', 150000, 190000, 'USD', 'Product', 'https://job-boards.greenhouse.io/cobaltrobotics/jobs/999', datetime('now'), ?, 'active')`,
).run(company.id, hash);

db.prepare(
  `INSERT INTO company_enrichments (company_id, kind, data, source_url, fetched_at) VALUES (?, 'leadership', '{"ceo":"Dana Whitfield"}', 'https://linkedin.com/in/example', datetime('now'))
   ON CONFLICT (company_id, kind) DO UPDATE SET data = excluded.data, fetched_at = datetime('now')`,
).run(company.id);

const run = db.prepare(`INSERT INTO sync_runs (status, companies_synced, roles_inserted) VALUES ('success', 1, 1)`).run();

const companies = db.prepare(`SELECT * FROM companies`).all();
const sources = db.prepare(`SELECT * FROM company_sources`).all();
const roles = db.prepare(`SELECT * FROM roles`).all();
const enrichments = db.prepare(`SELECT * FROM company_enrichments`).all();
const runs = db.prepare(`SELECT * FROM sync_runs`).all();

console.log("companies:", companies);
console.log("company_sources:", sources);
console.log("roles:", roles);
console.log("company_enrichments:", enrichments);
console.log("sync_runs:", runs);
console.log(`\nSmoke test OK (run id ${run.lastInsertRowid})`);
