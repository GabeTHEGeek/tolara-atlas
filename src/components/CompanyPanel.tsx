import type { LocationPinData } from "../types.js";
import { roleHref } from "../router.js";

interface CompanyPanelProps {
  pin: LocationPinData | null;
  onClose: () => void;
}

function formatSalary(min: number | null, max: number | null, currency: string | null): string | null {
  if (min == null && max == null) return null;
  const cur = currency ?? "USD";
  const fmt = (n: number) => `${cur} ${n.toLocaleString("en-US")}`;
  if (min != null && max != null && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt(min ?? max!);
}

export default function CompanyPanel({ pin, onClose }: CompanyPanelProps) {
  if (!pin) return null;

  const location = [pin.city, pin.state].filter(Boolean).join(", ") || "Location unknown";
  // Roles with no office of their own, shown here only because this pin is
  // their company's dominant location -- called out separately so it's
  // clear they aren't actually based in this city (see types.ts).
  const remoteCount = pin.roles.filter((role) => role.isRemote).length;

  return (
    <aside className="company-panel">
      <div className="company-panel-header">
        <div>
          <h2>{pin.companyName}</h2>
          <p className="company-panel-location">{location}</p>
        </div>
        <button className="company-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className="company-panel-role-count">
        {pin.roleCount} open Product Manager {pin.roleCount === 1 ? "role" : "roles"} in {location}
        {remoteCount > 0 && ` (${remoteCount} remote)`}
      </p>

      <ul className="role-list">
        {pin.roles.map((role) => {
          const salary = formatSalary(role.salaryMin, role.salaryMax, role.salaryCurrency);
          return (
            <li key={role.id} className="role-item">
              <div className="role-title-row">
                <a href={roleHref(pin.companySlug, role.id)} className="role-title">
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
                {role.isRemote && (
                  <span
                    className="role-remote-badge"
                    title={`No office of its own -- shown here because it's ${pin.companyName}'s dominant location`}
                  >
                    Remote
                  </span>
                )}
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
    </aside>
  );
}
