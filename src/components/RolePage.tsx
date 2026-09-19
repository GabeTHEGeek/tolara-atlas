import { useCallback, useEffect, useMemo, useState } from "react";
import { roleHref } from "../router.js";
import type {
  CompanyDetails,
  CompanyDetailsRole,
  CompanyIntelligenceData,
  HiringSignal,
  IntelligenceResponse,
  RoleFocus,
} from "../types.js";

export interface RoleLoadedInfo {
  company: string;
  role: string;
  offices: CompanyDetailsRole["offices"];
}

interface RolePageProps {
  companySlug: string;
  roleId: number;
  onLoaded: (info: RoleLoadedInfo | null) => void;
  // Called once the slide-out has finished, so the parent can change the route.
  onClose: () => void;
}

// Keep in step with the .role-drawer transition in styles.css.
export const DRAWER_SLIDE_MS = 650;

const SAVED_KEY = "tolara:saved-roles";

function readSaved(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function writeSaved(ids: number[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or blocked storage: saving just doesn't persist.
  }
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatMoney(n: number, currency: string | null): string {
  const k = n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
  return !currency || currency === "USD" ? `$${k}` : `${currency} ${k}`;
}

function salaryLabel(role: CompanyDetailsRole): string | null {
  const { salaryMin: min, salaryMax: max, salaryCurrency: cur } = role;
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${formatMoney(min, cur)} – ${formatMoney(max, cur)}`;
  return formatMoney((min ?? max)!, cur);
}

function locationLabel(role: CompanyDetailsRole): string {
  const real = role.offices.filter((o) => !o.isRemote);
  if (real.length > 0) {
    const names = [...new Set(real.map((o) => `${o.city}, ${o.state}`))];
    return names.length > 2 ? `${names.slice(0, 2).join(" · ")} +${names.length - 2}` : names.join(" · ");
  }
  if (role.offices.length > 0) return "Remote (US)";
  return role.location?.trim() || "Location not stated";
}

// Headlines that say something about hiring conditions become signals too.
const NEWS_SIGNALS: Array<{ pattern: RegExp; tone: HiringSignal["tone"] }> = [
  { pattern: /\b(raises?|raised|series [a-h]\b|funding|valuation|unicorn)/i, tone: "positive" },
  { pattern: /\b(layoffs?|lays off|laid off|job cuts|cuts jobs|restructur)/i, tone: "caution" },
  // Not "IPO": it turns up in anecdotes ("...After Airbnb's IPO") far more
  // often than in news about the company going public.
  { pattern: /\b(acquires?|acquired|acquisition|merger)\b/i, tone: "neutral" },
];

function roleSignals(role: CompanyDetailsRole, intel: CompanyIntelligenceData | null): HiringSignal[] {
  const signals: HiringSignal[] = [];
  const posted = role.postedAt && !Number.isNaN(Date.parse(role.postedAt)) ? role.postedAt : null;
  const since = posted ?? role.firstSeenAt;
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  const age = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  signals.push({
    text: posted ? `This role was posted ${age}` : `Tolara first saw this role ${age}`,
    tone: days <= 14 ? "positive" : days > 45 ? "caution" : "neutral",
    detail: posted ? "from posting" : "our sync",
  });
  for (const item of intel?.news ?? []) {
    const match = NEWS_SIGNALS.find((s) => s.pattern.test(item.title));
    if (match) {
      signals.push({ text: item.title, tone: match.tone, detail: [item.source, relativeTime(item.publishedAt)].filter(Boolean).join(" · ") });
    }
  }
  return signals;
}

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
 * Company/role intelligence as a floating panel that slides in over the
 * right side of the map (the map stays visible and flies to the role's
 * office). Stays mounted while moving between roles, so only the first
 * open and the final close animate.
 */
export default function RolePage({ companySlug, roleId, onLoaded, onClose }: RolePageProps) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<CompanyDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [intel, setIntel] = useState<CompanyIntelligenceData | null>(null);
  const [focus, setFocus] = useState<RoleFocus | null>(null);
  const [focusChecked, setFocusChecked] = useState(false);
  const [intelState, setIntelState] = useState<"idle" | "loading" | "error">("idle");
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [saved, setSaved] = useState<number[]>(readSaved);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setLoadError(null);
    setIntelState("idle");
    fetch(`/data/companies/${companySlug}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This company has no open roles on Tolara right now." : `HTTP ${res.status}`);
        return res.json() as Promise<CompanyDetails>;
      })
      .then((data) => {
        if (cancelled) return;
        setDetails(data);
        setIntel(data.intelligence);
        const role = data.roles.find((r) => r.id === roleId);
        setFocus(role?.focus ?? null);
        setFocusChecked(Boolean(role?.focus));
      })
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [companySlug, roleId]);

  const role = details?.roles.find((r) => r.id === roleId) ?? null;

  useEffect(() => {
    onLoaded(details && role ? { company: details.company.name, role: role.title, offices: role.offices } : null);
  }, [details, role, onLoaded]);

  // Slide in on the frame after mounting (so the closed position paints
  // first and the transform actually transitions).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(onClose, DRAWER_SLIDE_MS);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    scrollEl?.scrollTo({ top: 0 });
  }, [scrollEl, companySlug, roleId]);

  const shell = (content: React.ReactNode, label: string) => (
    <aside ref={setScrollEl} className={`role-drawer${open ? " is-open" : ""}`} role="dialog" aria-label={label}>
      <button className="drawer-close" onClick={close} aria-label="Close company intelligence">
        ×
      </button>
      {content}
    </aside>
  );

  const signals = useMemo(
    () => (details && role ? [...details.signals, ...roleSignals(role, intel)] : []),
    [details, role, intel],
  );

  const loadIntelligence = async () => {
    setIntelState("loading");
    try {
      const res = await fetch(`/api/intelligence?company=${encodeURIComponent(companySlug)}&role=${roleId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IntelligenceResponse;
      setIntel({ profile: data.profile, leaders: data.leaders, news: data.news, fetchedAt: data.fetchedAt });
      setUnavailable(data.unavailable ?? []);
      setFocus(data.focus);
      setFocusChecked(true);
      setIntelState("idle");
    } catch {
      setIntelState("error");
    }
  };

  if (loadError) {
    return shell(<p className="drawer-message">{loadError}</p>, "Role details");
  }
  if (!details) {
    return shell(<p className="drawer-message">Loading…</p>, "Role details");
  }
  if (!role) {
    return shell(
      <div className="drawer-message">
        <h1>This role is no longer open</h1>
        <p>
          {details.company.name} still has {details.roles.length} open PM{" "}
          {details.roles.length === 1 ? "role" : "roles"}:
        </p>
        <OtherRoles details={details} currentId={null} />
      </div>,
      "Role details",
    );
  }

  const isSaved = saved.includes(role.id);
  const toggleSave = () => {
    const next = isSaved ? saved.filter((id) => id !== role.id) : [...saved, role.id];
    setSaved(next);
    writeSaved(next);
  };
  const salary = salaryLabel(role);
  const intelLoaded = intel !== null;
  const profile = intel?.profile ?? null;

  return shell(
    <>
      <div className="role-drawer-body">
        <header className="role-header">
          <div>
            <h1 className="role-page-title">
              {role.title}
              {role.isNew && <span className="badge-new">NEW</span>}
            </h1>
            <p className="role-subtitle">
              {[details.company.name, role.team, locationLabel(role)].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="role-actions">
            <button className={`btn btn-secondary${isSaved ? " is-active" : ""}`} onClick={toggleSave} aria-pressed={isSaved}>
              {isSaved ? "Saved" : "Save"}
            </button>
            {role.url && (
              <a className="btn btn-primary" href={role.url} target="_blank" rel="noreferrer">
                View original posting
              </a>
            )}
          </div>
        </header>

        {salary && (
          <div className="salary-row">
            <span className="salary-chip">{salary}</span>
            <span className="mono-note">FROM POSTING · NOT ESTIMATED</span>
          </div>
        )}

        {!intelLoaded && (
          <div className="intel-banner">
            <div>
              <strong>Company intelligence</strong>
              <p>Company snapshot, leadership, recent news and what this role focuses on — looked up when you ask.</p>
              {intelState === "error" && (
                <p className="intel-error">Couldn't load it. It's only available while the Tolara server is running (npm run dev).</p>
              )}
            </div>
            <button className="btn btn-primary" onClick={loadIntelligence} disabled={intelState === "loading"}>
              {intelState === "loading" ? "Loading…" : "Load company intelligence"}
            </button>
          </div>
        )}

        {/* Once it's loaded (or was baked into the export from an earlier
            look-up) the banner goes away, so keep a way to re-run it -- the
            sources change, and a card can be empty because a source was
            briefly unreachable. */}
        {intelLoaded && (
          <div className="intel-status">
            <span>
              Company intelligence
              {intel.fetchedAt && <span className="muted"> · updated {relativeTime(intel.fetchedAt)}</span>}
            </span>
            <button className="link-button" onClick={loadIntelligence} disabled={intelState === "loading"}>
              {intelState === "loading" ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        )}
        {intelLoaded && intelState === "error" && (
          <p className="intel-error intel-status-error">
            Couldn't refresh it. It's only available while the Tolara server is running (npm run dev).
          </p>
        )}

        <div className="card-grid">
          <section className="card">
            <h2 className="card-label">Leadership</h2>
            {!intelLoaded ? (
              <p className="card-empty">Not loaded yet.</p>
            ) : intel.leaders.length > 0 ? (
              <ul className="leader-list">
                {intel.leaders.map((leader) => (
                  <li key={leader.wikidataUrl} className="leader">
                    <span className="avatar" aria-hidden="true">
                      {initials(leader.name)}
                    </span>
                    <span className="leader-text">
                      <strong>{leader.name}</strong>
                      <span>{leader.title}</span>
                    </span>
                    <a
                      className="btn-linkedin"
                      href={
                        leader.linkedinUrl ??
                        `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${leader.name} ${details.company.name}`)}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="in">in</span> LinkedIn
                    </a>
                  </li>
                ))}
              </ul>
            ) : unavailable.includes("profile") ? (
              <RetryNote source="Wikidata" onRetry={loadIntelligence} busy={intelState === "loading"} />
            ) : (
              <p className="card-empty">No leadership listed publicly for {details.company.name} yet.</p>
            )}
          </section>

          <section className="card">
            <h2 className="card-label">Company snapshot</h2>
            {!intelLoaded ? (
              <p className="card-empty">Not loaded yet.</p>
            ) : profile ? (
              <>
                {profile.logoUrl && (
                  <img
                    className="company-logo"
                    src={profile.logoUrl}
                    alt=""
                    width={40}
                    height={40}
                    loading="lazy"
                    // Clearbit serves a 404 for companies it has no logo for.
                    onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                )}
                <ul className="snapshot-lines">
                  {(profile.founded || profile.headquarters) && (
                    <li>{[profile.founded && `Founded ${profile.founded}`, profile.headquarters].filter(Boolean).join(" · ")}</li>
                  )}
                  {(profile.industries.length > 0 || profile.employees) && (
                    <li>
                      {[
                        profile.industries.map((i) => i.charAt(0).toUpperCase() + i.slice(1)).join(" / ") || null,
                        profile.employees
                          ? `${profile.employees.toLocaleString("en-US")} employees${profile.employeesAsOf ? ` (${profile.employeesAsOf})` : ""}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </li>
                  )}
                  {profile.description && <li>{profile.description.charAt(0).toUpperCase() + profile.description.slice(1)}</li>}
                </ul>
                {profile.website && (
                  <p className="snapshot-website">
                    <a href={profile.website} target="_blank" rel="noreferrer">
                      {profile.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                    </a>
                  </p>
                )}
                <span className="source-link">
                  via{" "}
                  {profile.sources.map((s, i) => (
                    <span key={s.label}>
                      {i > 0 && " · "}
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.label}
                        </a>
                      ) : (
                        s.label
                      )}
                    </span>
                  ))}
                </span>
              </>
            ) : unavailable.includes("profile") ? (
              <RetryNote source="Wikidata" onRetry={loadIntelligence} busy={intelState === "loading"} />
            ) : (
              <p className="card-empty">
                No public profile found for {details.company.name} yet.{" "}
                <button className="link-button" onClick={loadIntelligence} disabled={intelState === "loading"}>
                  {intelState === "loading" ? "Checking…" : "Check again"}
                </button>
              </p>
            )}
            {profile && !profile.description && !profile.founded && !profile.headquarters && (
              <p className="card-empty snapshot-thin">
                Wikidata has no entry for {details.company.name}, so only its website is known.
              </p>
            )}
          </section>

          <section className="card">
            <h2 className="card-label">Hiring signals</h2>
            <ul className="signal-list">
              {signals.map((s, i) => (
                <li key={i} className={`signal signal--${s.tone}`}>
                  <span className="signal-dot" aria-hidden="true" />
                  <span>
                    {s.text}
                    {s.detail && <span className="muted"> · {s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2 className="card-label">Recent news</h2>
            {!intelLoaded ? (
              <p className="card-empty">Not loaded yet.</p>
            ) : intel.news.length > 0 ? (
              <ul className="news-list">
                {intel.news.map((n) => (
                  <li key={n.url}>
                    <a href={n.url} target="_blank" rel="noreferrer">
                      {n.title}
                    </a>
                    <span className="muted">{[n.source, relativeTime(n.publishedAt)].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            ) : unavailable.includes("news") ? (
              <RetryNote source="Google News" onRetry={loadIntelligence} busy={intelState === "loading"} />
            ) : (
              <p className="card-empty">
                No news about {details.company.name} in the last 30 days.{" "}
                <button className="link-button" onClick={loadIntelligence} disabled={intelState === "loading"}>
                  {intelState === "loading" ? "Checking…" : "Check again"}
                </button>
              </p>
            )}
          </section>

          {(focus || focusChecked) && (
            <section className="card card--wide">
              <h2 className="card-label">What this role is likely focused on, from the posting</h2>
              {focus ? (
                <ul className="focus-list">
                  {focus.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              ) : (
                <p className="card-empty">This posting doesn't have a clear list of responsibilities to pull from.</p>
              )}
            </section>
          )}

          {details.roles.length > 1 && (
            <section className="card card--wide">
              <h2 className="card-label">More PM roles at {details.company.name}</h2>
              <OtherRoles details={details} currentId={role.id} />
            </section>
          )}
        </div>
      </div>
    </>,
    `${role.title} at ${details.company.name}`,
  );
}

function RetryNote({ source, onRetry, busy }: { source: string; onRetry: () => void; busy: boolean }) {
  return (
    <p className="card-empty">
      {source} didn't respond just now.{" "}
      <button className="link-button" onClick={onRetry} disabled={busy}>
        {busy ? "Trying…" : "Try again"}
      </button>
    </p>
  );
}

function OtherRoles({ details, currentId }: { details: CompanyDetails; currentId: number | null }) {
  const others = details.roles.filter((r) => r.id !== currentId);
  return (
    <ul className="other-roles">
      {others.map((r) => (
        <li key={r.id}>
          <a href={roleHref(details.company.slug, r.id)}>{r.title}</a>
          <span className="muted">{locationLabel(r)}</span>
        </li>
      ))}
    </ul>
  );
}
