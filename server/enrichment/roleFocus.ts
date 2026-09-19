/**
 * enrichment/roleFocus.ts
 * "What this role is likely focused on, from the posting": 3-5 short bullets.
 *
 * Free: re-fetches the posting's own HTML from its ATS (the stored
 * description is plain text with the list structure stripped out) and
 * takes the items of its "What you'll do" / "Responsibilities" list,
 * verbatim. Supported for Greenhouse, Ashby and Lever, which carry most
 * roles. When there's no such list, or the role is on another platform,
 * it returns null and the page says so -- no paid summarization API, by
 * design (the project has no API budget).
 */

const USER_AGENT = "TolaraAtlas/0.1 (https://github.com/GabeTHEGeek/tolara-atlas)";
const MAX_BULLETS = 5;
const MIN_BULLETS = 2;
const MAX_BULLET_CHARS = 180;

export interface RoleFocus {
  bullets: string[];
  method: "posting";
}

export interface RoleRef {
  platform: string;
  sourceJobId: string; // "gh_123", "ab_<uuid>", "lv_<uuid>", ...
  boardToken: string;
}

// Section headings that introduce what the person will actually do.
const FOCUS_HEADING =
  /what you['’]?ll do|what you will do|what you['’]?ll be doing|what you['’]?ll work on|responsibilit|in this role|the role|your role|you will|you['’]?ll|day[- ]to[- ]day|typical day|day in the life|your impact|what you['’]?ll own|key duties|about the job|the opportunity|your mission/i;
// Headings whose lists are about the candidate or the perks, not the work.
const NON_FOCUS_HEADING =
  /require|qualif|about you|you have|you bring|you['’]?ll need|must have|nice to have|bonus|preferred|benefit|perk|compensation|salary|we offer|why join|who you are|looking for|skills|experience|expertise|background/i;

// Items that describe the candidate rather than the work ("10+ years of...",
// "Experience with...", "Bachelor's degree"). A list mostly made of these is
// a requirements list whatever its heading says.
// Items describing perks, for lists that sit under a heading the regexes
// above don't recognize ("What's in it for you").
const BENEFIT_ITEM =
  /medical|dental|vision|401\(?k|paid time off|\bpto\b|holidays|parental leave|stipend|wellness|insurance|equity|retirement|reimburse/i;

const REQUIREMENT_ITEM =
  /\b\d+\+?\s*(?:years|yrs)\b|^(?:experience|proven|demonstrated|strong|excellent|bachelor|master|mba|degree|familiarity|proficien|ability to|track record)|\bexperience (?:with|in|working)\b/i;

// Lists that are recruiting/legal boilerplate rather than the job: scam
// warnings ("never asks candidates to pay..."), EEO and accommodation text.
const BOILERPLATE_ITEM = /never ask|scam|fraud|@|equal opportunity|accommodation|background check|e-verify|official communications/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;/g, "’")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  if (s.length <= MAX_BULLET_CHARS) return s;
  const cut = s.slice(0, MAX_BULLET_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "")}…`;
}

function listItems(ulHtml: string): string[] {
  return [...ulHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => textOf(m[1])).filter((t) => t.length > 3);
}

/**
 * The bullets under the posting's focus heading. Walks every <ul>, looks at
 * the text just before it (the heading it sits under), and prefers a list
 * whose heading reads like "What you'll do"; failing that, the first list
 * whose heading isn't obviously requirements or benefits.
 */
export function extractFocusFromHtml(html: string): string[] | null {
  const lists = [...html.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/gi)];
  let fallback: string[] | null = null;
  for (const m of lists) {
    // The heading directly above the list: the last sentence or fragment of
    // the text before it ("A Typical Day:", "Your Expertise:"). Reading
    // further back pulled in phrases like "you will" from the intro and
    // mistook a requirements list for the focus list.
    const before = textOf(html.slice(Math.max(0, m.index! - 400), m.index!));
    const heading = before.split(/(?<=[.!?])\s+/).pop() ?? "";
    const items = listItems(m[1]);
    if (items.length < MIN_BULLETS) continue;
    if (items.some((item) => BOILERPLATE_ITEM.test(item))) continue;
    if (items.filter((item) => REQUIREMENT_ITEM.test(item)).length > items.length / 2) continue;
    if (items.filter((item) => BENEFIT_ITEM.test(item)).length >= items.length / 2) continue;
    if (NON_FOCUS_HEADING.test(heading)) continue;
    if (FOCUS_HEADING.test(heading)) {
      return items.slice(0, MAX_BULLETS).map(clip);
    }
    fallback ??= items.slice(0, MAX_BULLETS).map(clip);
  }
  return fallback;
}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postingHtml(role: RoleRef): Promise<string | null> {
  const id = role.sourceJobId.replace(/^[a-z]{2}_/, "");
  const token = encodeURIComponent(role.boardToken);
  switch (role.platform) {
    case "greenhouse": {
      const job = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`)) as {
        content?: string;
      } | null;
      // Greenhouse returns the HTML itself entity-encoded.
      return job?.content ? decodeEntities(job.content) : null;
    }
    case "ashby": {
      const board = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`)) as {
        jobs?: Array<{ id: string; descriptionHtml?: string }>;
      } | null;
      return board?.jobs?.find((j) => j.id === id)?.descriptionHtml ?? null;
    }
    case "lever": {
      const job = (await getJson(`https://api.lever.co/v0/postings/${token}/${id}`)) as {
        description?: string;
        lists?: Array<{ text?: string; content?: string }>;
      } | null;
      if (!job) return null;
      // Lever keeps each section's heading and <li>s apart; stitch them back
      // into one document so the same heading-based extraction applies.
      const sections = (job.lists ?? []).map((l) => `<h3>${l.text ?? ""}</h3><ul>${l.content ?? ""}</ul>`);
      return `${job.description ?? ""}${sections.join("")}`;
    }
    default:
      return null;
  }
}

export async function fetchRoleFocus(role: RoleRef): Promise<RoleFocus | null> {
  const html = await postingHtml(role);
  const bullets = html ? extractFocusFromHtml(html) : null;
  return bullets && bullets.length >= MIN_BULLETS ? { bullets, method: "posting" } : null;
}
