/**
 * Mirrors the JSON shape written by server/export/exportMapData.ts. Keep
 * these two in sync by hand — the export script is the source of truth.
 *
 * A "pin" is one (company, city) pair, not one per company — a company
 * with active roles in more than one city has one LocationPinData entry
 * per city, each carrying only the roles actually posted there.
 */

/** Mirrors SENIORITY_TIERS in server/export/roleFacets.ts, same order. */
export const SENIORITY_TIERS = ["associate", "mid", "senior", "principal", "director"] as const;
export type Seniority = (typeof SENIORITY_TIERS)[number];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  associate: "Associate",
  mid: "Mid",
  senior: "Senior",
  principal: "Principal / GPM",
  director: "Director+",
};

export type { SalaryPeriod } from "./format.js";
import type { SalaryPeriod } from "./format.js";

export interface RoleData {
  id: number;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  // What the figures are per; null is treated as yearly. Hourly bands are
  // shown as-is rather than annualized -- see server/ingestion/salary.ts.
  salaryPeriod: SalaryPeriod | null;
  url: string | null;
  postedAt: string | null;
  // When our sync first saw the posting. Always present, unlike postedAt
  // (which is the board's own field, often missing or a relative string
  // like "Posted Yesterday"), so it's what the date filter falls back to.
  firstSeenAt: string;
  isNew: boolean;
  seniority: Seniority;
  // true when this role has no office of its own (e.g. posted as "Remote -
  // USA") and is shown at this pin only because it's the company's
  // dominant office, not because the role is actually based here.
  isRemote: boolean;
}

export interface ClosedRoleData {
  id: number;
  title: string;
  companyName: string;
  companySlug: string;
  city: string | null;
  state: string | null;
  url: string | null;
  // When we last saw the posting alive, not a board-supplied close date --
  // sync.ts closes a role a day after it stops appearing on its board.
  closedAt: string;
}

/** What moved in the last `windowDays` days. See exportMapData.ts. */
export interface ChangeFeedData {
  windowDays: number;
  since: string;
  added: number;
  closed: number;
  // Capped (200) -- `closed` is the real count.
  closedRoles: ClosedRoleData[];
  lastSync: { finishedAt: string | null; status: string } | null;
}

export interface LocationPinData {
  id: string;
  companyId: number;
  companyName: string;
  companySlug: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  roleCount: number;
  roles: RoleData[];
}

// A company with at least one active role that has no resolvable location
// anywhere -- no office of its own, no company/board dominant office, no
// curated HQ (see server/ingestion/geocode.ts). No lat/lng, since there's
// no city to place a pin at; shown in an unmapped list instead so these
// roles are still findable rather than silently dropped.
export interface RemoteCompanyData {
  companyId: number;
  companyName: string;
  companySlug: string;
  roleCount: number;
  roles: RoleData[];
}

export interface MapData {
  generatedAt: string;
  companyCount: number;
  pinCount: number;
  roleCount: number;
  changes: ChangeFeedData;
  pins: LocationPinData[];
  remoteCompanies: RemoteCompanyData[];
}

// ---- Role page: mirrors server/export/companyDetails.ts and the
// /api/intelligence response (server/enrichment/intelligence.ts).

export interface CompanyProfile {
  wikidataId: string | null;
  wikidataUrl: string | null;
  logoUrl: string | null;
  sources: Array<{ label: string; url: string | null }>;
  description: string | null;
  founded: number | null;
  headquarters: string | null;
  industries: string[];
  employees: number | null;
  employeesAsOf: number | null;
  website: string | null;
  linkedinCompanyUrl: string | null;
}

export interface Leader {
  name: string;
  title: string;
  linkedinUrl: string | null;
  wikidataUrl: string;
}

export interface NewsItem {
  title: string;
  source: string | null;
  url: string;
  publishedAt: string | null;
}

export interface RoleFocus {
  bullets: string[];
  method: "posting";
}

export interface HiringSignal {
  text: string;
  tone: "positive" | "neutral" | "caution";
  detail: string;
}

export interface CompanyIntelligenceData {
  profile: CompanyProfile | null;
  leaders: Leader[];
  news: NewsItem[];
  fetchedAt: string | null;
}

export interface CompanyDetailsRole {
  id: number;
  title: string;
  team: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  url: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  isNew: boolean;
  seniority: Seniority;
  offices: Array<{ city: string; state: string; latitude: number; longitude: number; isRemote: boolean }>;
  focus: RoleFocus | null;
}

export interface CompanyDetails {
  generatedAt: string;
  company: { id: number; name: string; slug: string; trackedSince: string };
  signals: HiringSignal[];
  intelligence: CompanyIntelligenceData | null;
  roles: CompanyDetailsRole[];
}

export interface IntelligenceResponse extends CompanyIntelligenceData {
  focus: RoleFocus | null;
  // Sources that didn't respond this time (rate limit, timeout) -- shown as
  // "try again", never as "nothing found".
  unavailable: Array<"profile" | "news">;
}
