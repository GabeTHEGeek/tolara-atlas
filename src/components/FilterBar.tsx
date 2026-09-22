import { SENIORITY_LABELS, SENIORITY_TIERS, type Seniority } from "../types.js";
import { EMPTY_FILTERS, isFiltering, type RemoteMode, type RoleFilters } from "../filters.js";

interface FilterBarProps {
  filters: RoleFilters;
  onChange: (next: RoleFilters) => void;
  matched: number;
  total: number;
}

// Round numbers a PM search actually uses, rather than an even split of the
// observed range -- a $187,500 floor is nobody's mental model.
const SALARY_STEPS = [150_000, 175_000, 200_000, 250_000];

const POSTED_STEPS = [7, 14, 30];

const REMOTE_LABELS: Record<RemoteMode, string> = {
  all: "All locations",
  "office-only": "In-office only",
  "remote-only": "Remote only",
};

export default function FilterBar({ filters, onChange, matched, total }: FilterBarProps) {
  const active = isFiltering(filters);

  const toggleSeniority = (tier: Seniority) => {
    const next = new Set(filters.seniority);
    if (next.has(tier)) next.delete(tier);
    else next.add(tier);
    onChange({ ...filters, seniority: next });
  };

  return (
    <div className="filter-bar" role="group" aria-label="Filter roles">
      <div className="filter-row">
        {SENIORITY_TIERS.map((tier) => (
          <button
            key={tier}
            type="button"
            className={`filter-chip${filters.seniority.has(tier) ? " is-on" : ""}`}
            aria-pressed={filters.seniority.has(tier)}
            onClick={() => toggleSeniority(tier)}
          >
            {SENIORITY_LABELS[tier]}
          </button>
        ))}
      </div>

      <div className="filter-row">
        <button
          type="button"
          className={`filter-chip${filters.newOnly ? " is-on" : ""}`}
          aria-pressed={filters.newOnly}
          onClick={() => onChange({ ...filters, newOnly: !filters.newOnly })}
          title="Roles badged NEW — posted in the last week"
        >
          New only
        </button>

        <label className="filter-select">
          <span className="filter-select-label">Pays</span>
          <select
            value={filters.minSalary ?? ""}
            onChange={(e) => onChange({ ...filters, minSalary: e.target.value ? Number(e.target.value) : null })}
            // Worth saying plainly: a floor can only be applied to roles
            // that publish a band, so picking one hides the rest.
            title="Only roles that publish a salary band can be matched against a floor"
          >
            <option value="">Any</option>
            {SALARY_STEPS.map((step) => (
              <option key={step} value={step}>
                ${step / 1000}k+
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span className="filter-select-label">Posted</span>
          <select
            value={filters.postedWithinDays ?? ""}
            onChange={(e) =>
              onChange({ ...filters, postedWithinDays: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Any time</option>
            {POSTED_STEPS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span className="filter-select-label">Where</span>
          <select
            value={filters.remote}
            onChange={(e) => onChange({ ...filters, remote: e.target.value as RemoteMode })}
          >
            {(Object.keys(REMOTE_LABELS) as RemoteMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {REMOTE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filter-summary">
        <span className={active ? "filter-count is-on" : "filter-count"}>
          {active ? `${matched.toLocaleString()} of ${total.toLocaleString()} roles` : `${total.toLocaleString()} roles`}
        </span>
        {active && (
          <button type="button" className="filter-clear" onClick={() => onChange({ ...EMPTY_FILTERS, seniority: new Set() })}>
            Clear
          </button>
        )}
      </div>

      {active && matched === 0 && (
        <p className="filter-empty">No roles match. Try widening the filters.</p>
      )}
    </div>
  );
}
