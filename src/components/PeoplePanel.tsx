import { relativeTime } from "../format.js";
import { findPeople, useContacts, useRoleContacts, type ContactLabel } from "../contacts.js";

const LABELS: Record<ContactLabel, string> = {
  hiring_manager: "Likely hiring manager",
  team_pm: "PM on the team",
  recruiter: "Recruiter",
  other: "Product leader",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * The button that starts a "Find people" run for one role. Used on role
 * prep and on job board cards. On a static build it says so instead.
 */
export function FindPeopleButton({ roleId, compact = false }: { roleId: number; compact?: boolean }) {
  const { local, job, blocked } = useContacts();
  if (local === null) return null;
  if (!local) {
    return compact ? null : (
      <span className="people-local-only" title="Find people drives your own LinkedIn in a local browser">
        Find people runs locally only
      </span>
    );
  }
  const running = job?.state === "running";
  const mine = running && job.roleId === roleId;
  return (
    <button
      type="button"
      className={compact ? "job-find" : "btn btn-secondary"}
      onClick={() => void findPeople(roleId)}
      disabled={running || Boolean(blocked)}
      title={blocked ?? (running && !mine ? "Already finding people for another role" : "Search LinkedIn for people to contact about this role")}
    >
      {mine ? "Finding…" : "Find people"}
    </button>
  );
}

/** "People to reach" on role prep: progress while it runs, then the people. */
export default function PeoplePanel({ roleId, company }: { roleId: number; company: string }) {
  const { result, job, local, blocked } = useRoleContacts(roleId);
  if (!local) return null;

  const running = job?.state === "running";
  const failed = job && (job.state === "error" || job.state === "stopped") ? job : null;

  return (
    <section className="card card--wide people-card">
      <div className="people-head">
        <h2 className="card-label">People to reach</h2>
        {result && !running && (
          <span className="muted people-when">
            found {relativeTime(result.foundAt)} ·{" "}
            <button className="link-button" onClick={() => void findPeople(roleId)} disabled={Boolean(blocked)}>
              Search again
            </button>
          </span>
        )}
      </div>

      {running && (
        <p className="people-progress" role="status">
          <span className="people-spinner" aria-hidden="true" />
          {job.message}
        </p>
      )}
      {failed && (
        <p className={failed.state === "stopped" ? "people-stop" : "intel-error"} role="alert">
          {failed.message}
          {/* A stop (security check, restriction) means don't retry; an error is the model or a blip. */}
          {failed.state === "error" && !blocked && (
            <>
              {" "}
              <button className="link-button" onClick={() => void findPeople(roleId)}>
                Try again
              </button>
            </>
          )}
        </p>
      )}

      {!running && !result && !failed && (
        <div className="people-empty">
          <p className="card-empty">
            Runs up to three LinkedIn searches in your own signed-in browser — the manager's title, the team, and posts
            about this opening — and keeps the people who work at {company} now. Takes about half a minute.
          </p>
          <FindPeopleButton roleId={roleId} />
        </div>
      )}

      {result && result.people.length === 0 && !running && (
        <p className="card-empty">
          No one clearly at {company} turned up in {result.searches.length} searches
          {result.hints.reportsTo ? ` (looked for the ${result.hints.reportsTo})` : ""}.
        </p>
      )}

      {result && result.people.length > 0 && (
        <ul className="leader-list people-list">
          {result.people.map((p) => (
            <li key={p.url} className="leader">
              <span className="avatar" aria-hidden="true">
                {initials(p.name)}
              </span>
              <span className="leader-text">
                <strong>
                  {p.name}
                  <span className={`people-label people-label--${p.label}`}>{LABELS[p.label]}</span>
                  <span className={`people-conf people-conf--${p.confidence}`} title={`${p.confidence} confidence`}>
                    {p.confidence}
                  </span>
                </strong>
                {p.headline && <span>{p.headline}</span>}
                <span className="people-reason">{p.reason}</span>
              </span>
              <a className="btn-linkedin" href={p.url} target="_blank" rel="noreferrer">
                {/* Found via a post, but most results pages expose only the author's profile. */}
                <span className="in">in</span> {/\/feed\/update\/|\/posts\//.test(p.url) ? "Post" : "Profile"}
              </a>
            </li>
          ))}
        </ul>
      )}

      {result && result.searches.length > 0 && !running && (
        <p className="source-link">
          Searched:{" "}
          {result.searches.map((s, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {s.kind === "posts" ? "posts" : "people"} “{s.keywords}” ({s.results})
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
