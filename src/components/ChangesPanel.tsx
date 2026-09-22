import { useMemo } from "react";
import type { MapData, RoleData } from "../types.js";
import { roleHref } from "../router.js";
import { relativeTime } from "../format.js";

interface ChangesPanelProps {
  data: MapData;
  open: boolean;
  onClose: () => void;
}

// The feed reports on the whole dataset, so a long list is possible; the
// rest is summarised rather than rendered.
const LIST_LIMIT = 120;

interface NewRoleEntry {
  role: RoleData;
  companyName: string;
  companySlug: string;
  where: string | null;
}

/**
 * Every role currently badged NEW, deduped -- a role open in three offices
 * is one entry, labelled with the office we'd show first.
 */
function newRoles(data: MapData): NewRoleEntry[] {
  const byId = new Map<number, NewRoleEntry>();
  for (const pin of data.pins) {
    for (const role of pin.roles) {
      if (!role.isNew || byId.has(role.id)) continue;
      byId.set(role.id, {
        role,
        companyName: pin.companyName,
        companySlug: pin.companySlug,
        where: [pin.city, pin.state].filter(Boolean).join(", ") || null,
      });
    }
  }
  for (const company of data.remoteCompanies) {
    for (const role of company.roles) {
      if (!role.isNew || byId.has(role.id)) continue;
      byId.set(role.id, {
        role,
        companyName: company.companyName,
        companySlug: company.companySlug,
        where: null,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.role.firstSeenAt) - Date.parse(a.role.firstSeenAt),
  );
}

export default function ChangesPanel({ data, open, onClose }: ChangesPanelProps) {
  const added = useMemo(() => (open ? newRoles(data) : []), [data, open]);
  if (!open) return null;

  const { changes } = data;
  const closed = changes.closedRoles;
  const syncedAt = relativeTime(changes.lastSync?.finishedAt ?? null);

  return (
    <aside className="changes-panel">
      <div className="company-panel-header">
        <div>
          <h2>What changed</h2>
          <p className="company-panel-location">
            Last {changes.windowDays} days
            {syncedAt && ` · synced ${syncedAt}`}
          </p>
        </div>
        <button className="company-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className="changes-summary">
        <span className="changes-stat is-added">+{changes.added.toLocaleString()} added</span>
        <span className="changes-stat is-closed">−{changes.closed.toLocaleString()} closed</span>
      </p>
      <p className="remote-panel-note">
        Counted from our own sync history, not the boards' — a role closes here a day after it stops appearing on
        its ATS.
      </p>

      <h3 className="changes-heading">New roles</h3>
      {added.length === 0 ? (
        <p className="remote-panel-note">Nothing new in this window.</p>
      ) : (
        <ul className="role-list">
          {added.slice(0, LIST_LIMIT).map(({ role, companyName, companySlug, where }) => (
            <li key={role.id} className="role-item">
              <div className="role-title-row">
                <a href={roleHref(companySlug, role.id)} className="role-title">
                  {role.title}
                </a>
                <span className="badge-new">NEW</span>
              </div>
              <div className="role-meta">
                <span className="changes-company">{companyName}</span>
                {where && <span>{where}</span>}
                <span>{relativeTime(role.firstSeenAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {added.length > LIST_LIMIT && (
        <p className="remote-panel-note">+{(added.length - LIST_LIMIT).toLocaleString()} more not listed.</p>
      )}

      <h3 className="changes-heading">Closed</h3>
      {closed.length === 0 ? (
        <p className="remote-panel-note">Nothing closed in this window.</p>
      ) : (
        <ul className="role-list">
          {closed.map((role) => (
            <li key={role.id} className="role-item is-closed">
              <div className="role-title-row">
                {/* No role page for a closed role -- it's out of the export.
                    The original posting is usually gone too, but it's the
                    only place left that might still show it. */}
                {role.url ? (
                  <a href={role.url} target="_blank" rel="noreferrer" className="role-title">
                    {role.title}
                  </a>
                ) : (
                  <span className="role-title">{role.title}</span>
                )}
              </div>
              <div className="role-meta">
                <span className="changes-company">{role.companyName}</span>
                {[role.city, role.state].filter(Boolean).length > 0 && (
                  <span>{[role.city, role.state].filter(Boolean).join(", ")}</span>
                )}
                <span title="The last day our sync saw this posting on its board">
                  last seen {relativeTime(role.closedAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {changes.closed > closed.length && (
        <p className="remote-panel-note">+{(changes.closed - closed.length).toLocaleString()} more not listed.</p>
      )}
    </aside>
  );
}
