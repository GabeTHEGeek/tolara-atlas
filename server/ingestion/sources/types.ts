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
  source: "greenhouse" | "ashby" | "lever";
  board: string;
}

export interface SearchMeta {
  boardsChecked: string[];
  boardsFailed: string[];
}

export interface SearchOptions {
  boards?: string[];
  limit?: number;
  excludeTitles?: string[];
  requireTitleKeywords?: string[];
}
