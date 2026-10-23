import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { SENIORITY_LABELS, SENIORITY_TIERS, type LocationPinData, type RemoteCompanyData, type RoleData, type Seniority } from "../types.js";
import { EMPTY_FILTERS, isFiltering, roleDate, type RemoteMode, type RoleFilters } from "../filters.js";
import { formatSalary, relativeTime } from "../format.js";
import { roleHref } from "../router.js";

/**
 * The job board: every role the map shows, as one searchable list.
 *
 * It reads the same filtered pins the map renders, so the two views can
 * never disagree about which roles exist -- switching views keeps your
 * filters. A role open in three offices is one row here, listing its
 * cities, where the map gives it three pins.
 */

export type JobSort = "newest" | "salary" | "company";

interface JobBoardProps {
  pins: LocationPinData[];
  remoteCompanies: RemoteCompanyData[];
  logos: Record<string, string>;
  filters: RoleFilters;
  onFiltersChange: (next: RoleFilters) => void;
  query: string;
  onQueryChange: (q: string) => void;
  sort: JobSort;
  onSortChange: (s: JobSort) => void;
  total: number;
}

interface JobRow {
  role: RoleData;
  companyName: string;
  companySlug: string;
  cities: string[]; // "Austin, TX", in pin order
  remote: boolean;
  date: number | null;
  searchText: string; // lowercased title + company + cities
}

const PAGE_SIZE = 50;

// Same steps as the map's FilterBar, so a filter set in one view reads the
// same in the other.
const SALARY_STEPS = [150_000, 175_000, 200_000, 250_000];
const POSTED_STEPS = [7, 14, 30];
const REMOTE_LABELS: Record<RemoteMode, string> = {
  all: "Anywhere",
  "office-only": "In-office",
  "remote-only": "Remote",
};

/** One row per role, its offices gathered from every pin it appears on. */
function buildRows(pins: LocationPinData[], remoteCompanies: RemoteCompanyData[]): JobRow[] {
  const byId = new Map<number, JobRow>();
  const add = (role: RoleData, companyName: string, companySlug: string, city: string | null) => {
    let row = byId.get(role.id);
    if (!row) {
      row = { role, companyName, companySlug, cities: [], remote: false, date: roleDate(role), searchText: "" };
      byId.set(role.id, row);
    }
    // A remote role sits at its company's main office on the map only so
    // it has somewhere to be; that office isn't where the job is.
    if (role.isRemote || !city) row.remote = true;
    else if (!row.cities.includes(city)) row.cities.push(city);
  };
  for (const pin of pins) {
    const city = pin.city ? (pin.state ? `${pin.city}, ${pin.state}` : pin.city) : null;
    for (const role of pin.roles) add(role, pin.companyName, pin.companySlug, city);
  }
  for (const company of remoteCompanies) {
    for (const role of company.roles) add(role, company.companyName, company.companySlug, null);
  }
  const rows = [...byId.values()];
  for (const row of rows) {
    row.searchText = `${row.role.title} ${row.companyName} ${row.cities.join(" ")}${row.remote ? " remote" : ""}`.toLowerCase();
  }
  return rows;
}

function sortRows(rows: JobRow[], sort: JobSort): JobRow[] {
  const sorted = [...rows];
  if (sort === "newest") {
    sorted.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  } else if (sort === "salary") {
    // Yearly bands only, highest ceiling first; hourly and unbanded roles
    // go last rather than being converted into a number nobody posted.
    const pay = (r: JobRow) =>
      (r.role.salaryPeriod ?? "year") === "year" ? (r.role.salaryMax ?? r.role.salaryMin ?? -1) : -1;
    sorted.sort((a, b) => pay(b) - pay(a) || (b.date ?? 0) - (a.date ?? 0));
  } else {
    sorted.sort((a, b) => a.companyName.localeCompare(b.companyName) || a.role.title.localeCompare(b.role.title));
  }
  return sorted;
}

function CompanyLogo({ name, slug, logo }: { name: string; slug: string; logo?: string }) {
  const [failed, setFailed] = useState(false);
  // A stable hue per company, so the same company always gets the same
  // initial colour down the list.
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  if (logo && !failed) {
    return (
      <span className="job-logo has-image">
        <img src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="job-logo" style={{ "--logo-hue": hash % 360 } as CSSProperties} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function locationLabel(row: JobRow): string {
  if (row.cities.length === 0) return row.remote ? "Remote" : "Location not listed";
  const first = row.cities[0];
  const more = row.cities.length - 1 + (row.remote ? 1 : 0);
  return more > 0 ? `${first} +${more}` : first;
}

/** A dropdown pill for the seniority tiers -- five chips is too many for the top row. */
function SeniorityPicker({ filters, onChange }: { filters: RoleFilters; onChange: (f: RoleFilters) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const chosen = SENIORITY_TIERS.filter((t) => filters.seniority.has(t));
  const label =
    chosen.length === 0 ? "Seniority" : chosen.length === 1 ? SENIORITY_LABELS[chosen[0]] : `${chosen.length} levels`;
  const toggle = (tier: Seniority) => {
    const next = new Set(filters.seniority);
    if (next.has(tier)) next.delete(tier);
    else next.add(tier);
    onChange({ ...filters, seniority: next });
  };

  return (
    <div className="job-picker" ref={ref}>
      <button
        type="button"
        className={`job-pill${chosen.length > 0 ? " is-on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="job-picker-menu" role="group" aria-label="Seniority">
          {SENIORITY_TIERS.map((tier) => (
            <label key={tier} className="job-picker-option">
              <input type="checkbox" checked={filters.seniority.has(tier)} onChange={() => toggle(tier)} />
              {SENIORITY_LABELS[tier]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function JobBoard({
  pins,
  remoteCompanies,
  logos,
  filters,
  onFiltersChange,
  query,
  onQueryChange,
  sort,
  onSortChange,
  total,
}: JobBoardProps) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const [moreOpen, setMoreOpen] = useState(filters.postedWithinDays != null || filters.newOnly);

  const rows = useMemo(() => buildRows(pins, remoteCompanies), [pins, remoteCompanies]);
  const matched = useMemo(() => {
    // Every word has to appear somewhere -- "senior stripe" finds Stripe's
    // senior roles rather than everything senior plus everything Stripe.
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length === 0 ? rows : rows.filter((r) => words.every((w) => r.searchText.includes(w)));
    return sortRows(hits, sort);
  }, [rows, query, sort]);

  // A new search or filter starts back at the top of the list.
  useEffect(() => setShown(PAGE_SIZE), [query, sort, filters]);

  const narrowed = isFiltering(filters) || query.trim() !== "";
  const clearAll = () => {
    onQueryChange("");
    onFiltersChange({ ...EMPTY_FILTERS, seniority: new Set() });
  };

  return (
    <div className="job-board">
      <div className="job-board-inner">
        <label className="job-search">
          <span aria-hidden="true" className="job-search-icon">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search roles, companies or cities"
            aria-label="Search roles, companies or cities"
            autoFocus
          />
        </label>

        <div className="job-controls">
          <SeniorityPicker filters={filters} onChange={onFiltersChange} />

          <label className={`job-pill job-pill-select${filters.minSalary != null ? " is-on" : ""}`}>
            <select
              value={filters.minSalary ?? ""}
              onChange={(e) => onFiltersChange({ ...filters, minSalary: e.target.value ? Number(e.target.value) : null })}
              title="Only roles that publish a salary band can be matched against a floor"
              aria-label="Minimum salary"
            >
              <option value="">Salary</option>
              {SALARY_STEPS.map((step) => (
                <option key={step} value={step}>
                  ${step / 1000}k+
                </option>
              ))}
            </select>
          </label>

          <label className={`job-pill job-pill-select${filters.remote !== "all" ? " is-on" : ""}`}>
            <select
              value={filters.remote}
              onChange={(e) => onFiltersChange({ ...filters, remote: e.target.value as RemoteMode })}
              aria-label="Remote or in-office"
            >
              {(Object.keys(REMOTE_LABELS) as RemoteMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {mode === "all" ? "Remote" : REMOTE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`job-pill${filters.postedWithinDays != null || filters.newOnly ? " is-on" : ""}`}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
          >
            More filters
          </button>

          <span className="job-summary">
            <span>
              {matched.length.toLocaleString()} {narrowed ? `of ${total.toLocaleString()} ` : ""}roles
            </span>
            <label className="job-sort">
              <select value={sort} onChange={(e) => onSortChange(e.target.value as JobSort)} aria-label="Sort by">
                <option value="newest">Newest</option>
                <option value="salary">Highest salary</option>
                <option value="company">Company A–Z</option>
              </select>
            </label>
          </span>
        </div>

        {moreOpen && (
          <div className="job-more">
            <label className={`job-pill job-pill-select${filters.postedWithinDays != null ? " is-on" : ""}`}>
              <select
                value={filters.postedWithinDays ?? ""}
                onChange={(e) =>
                  onFiltersChange({ ...filters, postedWithinDays: e.target.value ? Number(e.target.value) : null })
                }
                aria-label="Posted within"
              >
                <option value="">Posted any time</option>
                {POSTED_STEPS.map((days) => (
                  <option key={days} value={days}>
                    Posted in the last {days} days
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`job-pill${filters.newOnly ? " is-on" : ""}`}
              aria-pressed={filters.newOnly}
              onClick={() => onFiltersChange({ ...filters, newOnly: !filters.newOnly })}
              title="Roles badged New — first seen in the last week"
            >
              New only
            </button>
            {filters.minSalary != null && (
              <span className="job-note">Salary filters only match roles that publish a band.</span>
            )}
          </div>
        )}

        {narrowed && (
          <button type="button" className="job-clear" onClick={clearAll}>
            Clear search and filters
          </button>
        )}

        {matched.length === 0 ? (
          <div className="job-empty">
            <p className="job-empty-title">No roles match that</p>
            <p>Try fewer words, or widen the filters.</p>
            <button type="button" className="job-pill" onClick={clearAll}>
              Clear search and filters
            </button>
          </div>
        ) : (
          <ul className="job-list">
            {matched.slice(0, shown).map((row) => {
              const salary = formatSalary(row.role.salaryMin, row.role.salaryMax, row.role.salaryCurrency, row.role.salaryPeriod);
              const when = row.date != null ? relativeTime(new Date(row.date).toISOString()) : null;
              return (
                <li key={row.role.id} className="job-row">
                  <CompanyLogo name={row.companyName} slug={row.companySlug} logo={logos[row.companySlug]} />
                  <div className="job-main">
                    <p className="job-title">
                      {row.role.url ? (
                        <a href={row.role.url} target="_blank" rel="noopener noreferrer">
                          {row.role.title}
                        </a>
                      ) : (
                        row.role.title
                      )}
                      {row.role.isNew && <span className="job-new">New</span>}
                    </p>
                    <p className="job-meta">
                      <span className="job-company">{row.companyName}</span>
                      <span title={row.cities.length > 1 ? row.cities.join(" · ") : undefined}>{locationLabel(row)}</span>
                      {when && <span>{when}</span>}
                    </p>
                    {salary ? <span className="job-salary">{salary}</span> : <span className="job-nosalary">Salary not listed</span>}
                  </div>
                  <div className="job-actions">
                    {row.role.url && (
                      <a className="job-view" href={row.role.url} target="_blank" rel="noopener noreferrer">
                        View posting <span aria-hidden="true">↗</span>
                      </a>
                    )}
                    <a className="job-prep" href={roleHref(row.companySlug, row.role.id)}>
                      Role prep
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {matched.length > shown && (
          <button type="button" className="job-more-button" onClick={() => setShown((n) => n + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, matched.length - shown)} more
          </button>
        )}
      </div>
    </div>
  );
}
