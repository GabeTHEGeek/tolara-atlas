/**
 * Mirrors the JSON shape written by server/export/exportMapData.ts. Keep
 * these two in sync by hand — the export script is the source of truth.
 */

export interface RoleData {
  id: number;
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  url: string | null;
  postedAt: string | null;
}

export interface CompanyData {
  id: number;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  roleCount: number;
  roles: RoleData[];
}

export interface MapData {
  generatedAt: string;
  companyCount: number;
  roleCount: number;
  companies: CompanyData[];
}
