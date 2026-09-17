/**
 * Mirrors the JSON shape written by server/export/exportMapData.ts. Keep
 * these two in sync by hand — the export script is the source of truth.
 *
 * A "pin" is one (company, city) pair, not one per company — a company
 * with active roles in more than one city has one LocationPinData entry
 * per city, each carrying only the roles actually posted there.
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
  // true when this role has no office of its own (e.g. posted as "Remote -
  // USA") and is shown at this pin only because it's the company's
  // dominant office, not because the role is actually based here.
  isRemote: boolean;
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

export interface MapData {
  generatedAt: string;
  companyCount: number;
  pinCount: number;
  roleCount: number;
  pins: LocationPinData[];
}
