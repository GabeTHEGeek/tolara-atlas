/**
 * ingestion/fetchDescriptions.ts
 * Fills in the posting text for roles whose board's list endpoint doesn't
 * include it -- Workday's search returns titles, locations and dates only,
 * and the text needs one more request per posting.
 *
 * Only roles with no stored text are fetched, newest first, so after the
 * first run a nightly pass only touches what was posted since yesterday.
 * Time-budgeted (--minutes) like prewarm.ts, so a big backlog spreads over
 * several nights instead of stretching one. While the full text is in hand
 * it also fills in a missing salary band, since many Workday postings state
 * pay only in the body.
 *
 * Never touches content_hash: the sync hashes what the board's list
 * endpoint returns (no description), so leaving the hash alone means the
 * next sync still sees the posting as unchanged. sync.ts keeps a stored
 * description when the board sends none.
 *
 * Usage: npm run descriptions -- --minutes=10
 */

import { getDb } from "../db/client.js";
import { decodeEntities, stripHtml } from "./sources/common.js";
import { extractSalary } from "./extract.js";
import { parseSalary } from "./salary.js";

const USER_AGENT = "Mozilla/5.0 (compatible; TolaraAtlas/0.1; +https://github.com/GabeTHEGeek/tolara-atlas)";
const MAX_DESCRIPTION = 4000; // same cap the adapters use
const MIN_TEXT = 200; // shorter than this counts as missing

type Fetcher = (url: string) => Promise<string | null>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url: string, timeoutMs = 20000): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stored Workday URL is the candidate-facing page,
 * https://{tenant}.{dc}.myworkdayjobs.com/{site}/job/...; the same
 * path under /wday/cxs/{tenant}/{site} is the JSON the page itself loads.
 */
const fetchWorkday: Fetcher = async (url) => {
  const m = url.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/.+)$/);
  if (!m) return null;
  const [, tenant, dc, site, path] = m;
  const data = (await getJson(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`)) as {
    jobPostingInfo?: { jobDescription?: string };
  } | null;
  return data?.jobPostingInfo?.jobDescription ?? null;
};

// One entry per platform this can fill in, with how gently to ask: Workday
// tenants sit behind a WAF, so two at a time with a pause between.
const FETCHERS: Record<string, { fetch: Fetcher; concurrency: number; delayMs: number }> = {
  workday: { fetch: fetchWorkday, concurrency: 2, delayMs: 300 },
};

function minutesArg(): number {
  const raw = process.argv.find((a) => a.startsWith("--minutes="))?.split("=")[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

async function main() {
  const db = getDb();
  const deadline = Date.now() + minutesArg() * 60_000;
  const platforms = Object.keys(FETCHERS);

  const pending = db
    .prepare(
      `SELECT id, platform, url, salary_min FROM roles
       WHERE status = 'active' AND url IS NOT NULL
         AND platform IN (${platforms.map(() => "?").join(",")})
         AND (description IS NULL OR length(description) < ${MIN_TEXT})
       ORDER BY first_seen_at DESC`,
    )
    .all(...platforms) as Array<{ id: number; platform: string; url: string; salary_min: number | null }>;
  console.log(`Descriptions missing: ${pending.length} (${platforms.join(", ")})`);

  const setDescription = db.prepare(`UPDATE roles SET description = ? WHERE id = ?`);
  const setSalary = db.prepare(
    `UPDATE roles SET salary_min = @min, salary_max = @max, salary_currency = @currency, salary_period = @period
     WHERE id = @id AND salary_min IS NULL`,
  );

  let filled = 0;
  let salaries = 0;
  let failed = 0;
  let outOfTime = false;
  for (const platform of platforms) {
    const { fetch: fetchOne, concurrency, delayMs } = FETCHERS[platform];
    const queue = pending.filter((r) => r.platform === platform);
    const worker = async () => {
      while (queue.length > 0) {
        if (Date.now() > deadline) {
          outOfTime = true;
          return;
        }
        const role = queue.shift()!;
        const html = await fetchOne(role.url);
        const text = html ? decodeEntities(stripHtml(decodeEntities(html))).replace(/\s+/g, " ").trim() : "";
        if (text.length >= MIN_TEXT) {
          setDescription.run(text.slice(0, MAX_DESCRIPTION), role.id);
          filled++;
          if (role.salary_min == null) {
            const parsed = parseSalary(extractSalary(text));
            if (parsed.min != null) {
              setSalary.run({ id: role.id, ...parsed });
              salaries++;
            }
          }
        } else failed++;
        await sleep(delayMs);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  console.log(
    `Filled ${filled} descriptions (${salaries} with a salary band found in the text); ${failed} unavailable` +
      (outOfTime ? `; stopped at the time budget -- the rest wait for the next run` : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
