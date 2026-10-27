/**
 * ingestion/fetchDescriptions.ts
 * Fills in the posting text for roles whose board's list endpoint doesn't
 * include it -- Workday, Microsoft, Meta, Oracle, Eightfold, BambooHR and
 * some iCIMS tenants return titles, locations and dates only, and the text
 * needs one more request per posting.
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
 * Usage: npm run descriptions -- --minutes=10 [--only=workday,oracle]
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

/**
 * One GET, retrying a 429 a few times after a flat wait -- Microsoft's
 * endpoint refuses quick requests with no Retry-After (see
 * sources/microsoft.ts). Returns the body text, or null.
 */
async function getText(url: string, { json = false, rateLimitWaitMs = 15000, timeoutMs = 20000 } = {}): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: json ? "application/json" : "text/html,application/json" },
      });
      if (resp.status === 429) {
        await sleep(rateLimitWaitMs);
        continue;
      }
      return resp.ok ? await resp.text() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getJson(url: string, opts?: { rateLimitWaitMs?: number }): Promise<unknown | null> {
  const text = await getText(url, { json: true, ...opts });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The schema.org JobPosting a page embeds for search engines -- Meta's and
 * iCIMS's job pages both carry one. Joins its description with the
 * responsibilities/qualifications fields some boards split out.
 */
function jobPostingFromHtml(html: string): string | null {
  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(block[1]) as unknown;
      const items = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
      const posting = items.find((i) => i?.["@type"] === "JobPosting") ?? items.flatMap((i) => (i?.["@graph"] as Array<Record<string, unknown>>) ?? []).find((i) => i?.["@type"] === "JobPosting");
      if (!posting) continue;
      const parts = ["description", "responsibilities", "qualifications", "experienceRequirements"]
        .map((k) => posting[k])
        .map((v) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : ""))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    } catch {
      /* a malformed block -- try the next */
    }
  }
  return null;
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

/** https://apply.careers.microsoft.com/careers/job/{id} -> the PCSX details the page loads. */
const fetchMicrosoft: Fetcher = async (url) => {
  const id = url.match(/\/careers\/job\/(\d+)/)?.[1];
  if (!id) return null;
  const data = (await getJson(
    `https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=${id}&domain=microsoft.com&hl=en`,
  )) as { data?: { jobDescription?: string } } | null;
  return data?.data?.jobDescription ?? null;
};

/** {host}/careers/job/{id}?domain={domain} -> Eightfold's per-job JSON (the list omits text even with full=true). */
const fetchEightfold: Fetcher = async (url) => {
  const m = url.match(/^https:\/\/([^/]+)\/careers\/job\/(\d+)\?domain=([^&]+)/);
  if (!m) return null;
  const data = (await getJson(`https://${m[1]}/api/apply/v2/jobs/${m[2]}?domain=${m[3]}`)) as { job_description?: string } | null;
  return data?.job_description ?? null;
};

/** {host}/hcmUI/CandidateExperience/en/sites/{site}/job/{id} -> Oracle's requisition details. */
const fetchOracle: Fetcher = async (url) => {
  const m = url.match(/^https:\/\/([^/]+)\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([^/]+)\/job\/(\d+)/);
  if (!m) return null;
  const [, host, site, id] = m;
  const data = (await getJson(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`,
  )) as { items?: Array<Record<string, unknown>> } | null;
  const item = data?.items?.[0] as (Record<string, unknown> & { requisitionFlexFields?: Array<{ Prompt?: string; Value?: string }> }) | undefined;
  if (!item) return null;
  const text = ["ExternalDescriptionStr", "ExternalResponsibilitiesStr", "ExternalQualificationsStr"].map((k) => String(item[k] ?? "")).join(" ");
  // Amex states pay in a custom "Salary Range" field, not in the text.
  const pay = (item.requisitionFlexFields ?? []).find((f) => /salary|pay|compensation/i.test(f.Prompt ?? ""));
  return pay?.Value ? `${text} ${pay.Prompt}: ${pay.Value}` : text;
};

/** {tenant}.bamboohr.com/careers/{id} -> the same path + /detail, which is JSON. */
const fetchBambooHr: Fetcher = async (url) => {
  const m = url.match(/^(https:\/\/[^/]+\.bamboohr\.com\/careers\/\d+)/);
  if (!m) return null;
  const data = (await getJson(`${m[1]}/detail`)) as { result?: { jobOpening?: { description?: string } } } | null;
  return data?.result?.jobOpening?.description ?? null;
};

/**
 * jobs.ashbyhq.com/{board}/{id} -> the posting via the board page's GraphQL.
 * Only boards whose public API is switched off (Whatnot) reach this: every
 * other Ashby board's postings arrive with their text already.
 */
const fetchAshby: Fetcher = async (url) => {
  const m = url.match(/^https:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/);
  if (!m) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { organizationHostedJobsPageName: m[1], jobPostingId: m[2] },
        query: `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
          jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { descriptionHtml }
        }`,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { jobPosting?: { descriptionHtml?: string } | null } };
    return data.data?.jobPosting?.descriptionHtml ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Meta's job page redirects to its profile view, which embeds a JobPosting. */
const fetchMeta: Fetcher = async (url) => {
  const html = await getText(url);
  return html ? jobPostingFromHtml(html) : null;
};

/** iCIMS job pages (in_iframe=1, the same WAF-free view icims.ts lists from) embed a JobPosting. */
const fetchIcims: Fetcher = async (url) => {
  const html = await getText(`${url}${url.includes("?") ? "&" : "?"}in_iframe=1`);
  return html ? jobPostingFromHtml(html) : null;
};

// One entry per platform, with how gently to ask, run in this order. The
// quick ones go first so Microsoft -- one request per ~12s, its measured
// limit -- can't spend the whole time budget before they get a turn; its
// backlog finishes over a couple of nights. Meta gets the same 1.5s spacing
// sources/meta.ts uses.
const FETCHERS: Record<string, { fetch: Fetcher; concurrency: number; delayMs: number }> = {
  workday: { fetch: fetchWorkday, concurrency: 2, delayMs: 300 },
  oracle: { fetch: fetchOracle, concurrency: 2, delayMs: 300 },
  eightfold: { fetch: fetchEightfold, concurrency: 2, delayMs: 300 },
  bamboohr: { fetch: fetchBambooHr, concurrency: 2, delayMs: 300 },
  icims: { fetch: fetchIcims, concurrency: 2, delayMs: 300 },
  ashby: { fetch: fetchAshby, concurrency: 2, delayMs: 300 },
  meta: { fetch: fetchMeta, concurrency: 1, delayMs: 1500 },
  microsoft: { fetch: fetchMicrosoft, concurrency: 1, delayMs: 12000 },
};

function minutesArg(): number {
  const raw = process.argv.find((a) => a.startsWith("--minutes="))?.split("=")[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

async function main() {
  const db = getDb();
  const deadline = Date.now() + minutesArg() * 60_000;
  // --only=oracle,eightfold limits a run to some platforms (e.g. to re-test one).
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const platforms = Object.keys(FETCHERS).filter((p) => !only || only.includes(p));

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
