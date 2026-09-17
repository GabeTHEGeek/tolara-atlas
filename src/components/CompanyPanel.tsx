import type { CompanyData } from "../types.js";

interface CompanyPanelProps {
  company: CompanyData | null;
  onClose: () => void;
}

function formatSalary(min: number | null, max: number | null, currency: string | null): string | null {
  if (min == null && max == null) return null;
  const cur = currency ?? "USD";
  const fmt = (n: number) => `${cur} ${n.toLocaleString("en-US")}`;
  if (min != null && max != null && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt(min ?? max!);
}

export default function CompanyPanel({ company, onClose }: CompanyPanelProps) {
  if (!company) return null;

  const pinLocation = [company.city, company.state].filter(Boolean).join(", ") || "Location unknown";

  return (
    <aside className="company-panel">
      <div className="company-panel-header">
        <div>
          <h2>{company.name}</h2>
          <p className="company-panel-location">{pinLocation}</p>
        </div>
        <button className="company-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className="company-panel-role-count">
        {company.roleCount} open Product Manager {company.roleCount === 1 ? "role" : "roles"}
      </p>

      <ul className="role-list">
        {company.roles.map((role) => {
          const salary = formatSalary(role.salaryMin, role.salaryMax, role.salaryCurrency);
          return (
            <li key={role.id} className="role-item">
              <a href={role.url ?? "#"} target="_blank" rel="noreferrer" className="role-title">
                {role.title}
              </a>
              <div className="role-meta">
                {role.location && <span>{role.location}</span>}
                {salary && (
                  <span className="role-salary" title="From the posting, not estimated">
                    {salary}
                  </span>
                )}
              </div>
              {role.differentOffice && (
                <div
                  className="role-different-office"
                  title={`This pin is placed at ${pinLocation}, but this role's posting lists a different location.`}
                >
                  ⚠ Different office than the pin ({pinLocation})
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
