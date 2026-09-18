/**
 * Shared shape every ATS adapter normalizes its postings into, plus the
 * per-search metadata each adapter returns alongside the job list.
 */
export interface RawJob {
  id: string; // platform-prefixed, e.g. "gh_12345", "ab_<uuid>", "lv_<id>"
  title: string;
  company: string; // board token
  url: string;
  location: string;
  salary: string; // best-effort string, "" if nothing found — never fabricated
  category: string;
  published: string; // raw ISO string or platform-specific raw value
  description: string; // truncated to 4000 chars
  source: "greenhouse" | "ashby" | "lever" | "bamboohr";
  board: string;
}

export interface SearchMeta {
  boardsChecked: string[];
  // A board the fetch could not complete at all -- timed out (even after
  // retry), a network error, or a non-2xx response. Distinct from a board
  // that loaded fine but genuinely has zero current postings, which now
  // counts as checked, not failed.
  boardsFailed: string[];
  // A board that loaded successfully but returned zero postings. Counted
  // separately from boardsFailed so a dead token/timeout isn't confused
  // with a real company that simply has nothing open right now.
  boardsEmpty: string[];
}

export interface SearchOptions {
  boards?: string[];
  limit?: number;
  excludeTitles?: string[];
  requireTitleKeywords?: string[];
}
