import type { RemoteCompanyData } from "../types.js";
import { roleHref } from "../router.js";
import { formatSalary } from "../format.js";

interface RemotePanelProps {
  companies: RemoteCompanyData[];
  open: boolean;
  onClose: () => void;
}
// Companies whose active roles have no resolvable location anywhere (see
// RemoteCompanyData) -- not placeable on the map, so they're listed here
// instead of silently dropped. Distinct from CompanyPanel, which shows the
// roles at ONE map pin; this shows every such company at once, since
// there's no single pin to attach the list to.
export default function RemotePanel({ companies, open, onClose }: RemotePanelProps) {
  if (!open) return null;

  const totalRoles = companies.reduce((sum, c) => sum + c.roleCount, 0);

  return (
    <aside className="remote-panel">
      <div className="company-panel-header">
        <div>
          <h2>Remote-first companies</h2>
          <p className="company-panel-location">
            {companies.length} {companies.length === 1 ? "company" : "companies"} · {totalRoles} open{" "}
            {totalRoles === 1 ? "role" : "roles"} with no office we could pin
          </p>
        </div>
        <button className="company-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className="remote-panel-note">
        These companies' postings (and their wider hiring across every department) never mention a specific
        city, so there's nowhere accurate to place them on the map. Their open roles are listed here instead.
      </p>

      <div className="remote-company-list">
        {companies.map((company) => (
          <div key={company.companyId} className="remote-company-group">
            <h3 className="remote-company-name">
              {company.companyName}
              <span className="remote-company-count"> · {company.roleCount}</span>
            </h3>
            <ul className="role-list">
              {company.roles.map((role) => {
                const salary = formatSalary(role.salaryMin, role.salaryMax, role.salaryCurrency, role.salaryPeriod);
                return (
                  <li key={role.id} className="role-item">
                    <div className="role-title-row">
                      <a href={roleHref(company.companySlug, role.id)} className="role-title">
                        {role.title}
                      </a>
                      {role.url && (
                        <a
                          href={role.url}
                          target="_blank"
                          rel="noreferrer"
                          className="role-external"
                          aria-label={`Open the original posting for ${role.title}`}
                          title="Original posting"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                    <div className="role-meta">
                      {role.location && <span>{role.location}</span>}
                      {salary && (
                        <span className="role-salary" title="From the posting, not estimated">
                          {salary}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  );
}
