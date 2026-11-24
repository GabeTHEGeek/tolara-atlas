import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { KIT_FORM_ID, subscribe } from "../kit.js";
import { LANDING_LOGOS } from "../landingLogos.js";
import { LEVELS, METROS, landingRoles, payByLevel, slice, type LandingRole, type LevelId, type MetroId } from "../landingStats.js";
import { formatSalary, openSince } from "../format.js";
import { roleDate } from "../filters.js";
import { roleHref } from "../router.js";
import type { MapData } from "../types.js";
import "../landing.css";

/**
 * The landing page at #/welcome. Every figure on it comes from map-data.json,
 * the file the nightly sync rewrites, so it updates with the board and never
 * needs editing by hand. Classes are all lp-* so nothing here leaks into the
 * board's own styles.
 */

const DAY_MS = 86_400_000;
const fmt = (n: number) => n.toLocaleString("en-US");
const k = (n: number) => `$${Math.round(n / 1000)}k`;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private window: the pick just isn't remembered */
    }
  },
};

const LEVEL_WORD: Record<LevelId, string> = {
  all: "PM",
  associate: "APM",
  mid: "PM",
  senior: "Senior PM",
  principal: "Staff & Principal PM",
  director: "Director-level PM",
};

function metroWords(metro: MetroId): string {
  if (metro === "all") return "in the US";
  if (metro === "remote") return "that are remote";
  return `in ${METROS.find(([id]) => id === metro)?.[1] ?? "the US"}`;
}

function boardLink(level: LevelId, metro: MetroId): string {
  const params = new URLSearchParams();
  if (level !== "all") params.set("sen", level);
  params.set("ghost", "hide");
  if (metro === "remote") params.set("where", "remote-only");
  return `#/jobs?${params}`;
}

/** A short band, "$154–298k", for yearly USD; the board's own format otherwise. */
function pay(r: LandingRole): string | null {
  const { salaryMin, salaryMax, salaryCurrency, salaryPeriod } = r.role;
  if ((salaryPeriod ?? "year") === "year" && (salaryCurrency ?? "USD") === "USD") {
    const lo = salaryMin != null ? Math.round(salaryMin / 1000) : null;
    const hi = salaryMax != null ? Math.round(salaryMax / 1000) : null;
    if (lo != null && hi != null) return lo === hi ? `$${hi}k` : `$${lo}–${hi}k`;
    if (lo != null || hi != null) return `$${lo ?? hi}k`;
  }
  return formatSalary(salaryMin, salaryMax, salaryCurrency, salaryPeriod ?? "year");
}

/** Where a role is, preferring the place the reader picked. */
function place(r: LandingRole, picked: MetroId = "all"): string {
  if (picked !== "all" && r.metros.has(picked)) return METROS.find(([id]) => id === picked)![1];
  if (r.metros.has("remote") && r.metros.size === 1) return "Remote";
  const metro = METROS.find(([id]) => id !== "remote" && id !== "all" && r.metros.has(id));
  return metro ? metro[1] : (r.role.location ?? "US");
}

const FEATURES: Array<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: "Map of every PM job",
    body: "Every open US role on one map. Click a city to see who's hiring there.",
    icon: (
      <>
        <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
        <path d="M9 4v14M15 6v14" />
      </>
    ),
  },
  {
    title: "Your match score",
    body: "Answer a one-minute quiz and every role gets a score for how well it fits your experience, level and pay.",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="12" cy="12" r="0.8" />
      </>
    ),
  },
  {
    title: "Pay bands, ranked",
    body: "The posted salary range on every role that has one, and how it ranks: “Top 10% pay for Senior”.",
    icon: (
      <>
        <path d="M4 19h16" />
        <path d="M7 16V10M12 16V6M17 16v-4" />
      </>
    ),
  },
  {
    title: "Ghost job flags",
    body: "Roles open 90+ days, or taken down and reposted, get a flag. Hide them all with one filter.",
    icon: (
      <>
        <path d="M6 20V11a6 6 0 0 1 12 0v9l-2-1.5L14 20l-2-1.5L10 20l-2-1.5L6 20Z" />
        <circle cx="10" cy="11" r="0.8" />
        <circle cx="14" cy="11" r="0.8" />
      </>
    ),
  },
  {
    title: "Days open and reposts",
    body: "Every role shows how long it has been open, counted from the original posting even after a repost.",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </>
    ),
  },
  {
    title: "Filters that matter",
    body: "Level, salary floor, industry, remote or office, posted this week, new only. Combine them in two clicks.",
    icon: <path d="M4 6h16M7 12h10M10 18h4" />,
  },
  {
    title: "Company intelligence",
    body: "For each company: size, leadership, recent news and whether it's hiring more PMs or fewer than last month.",
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 7h8M8 11h8M8 15h5" />
      </>
    ),
  },
  {
    title: "Role prep",
    body: "Open any role for what it asks for, how your experience fits, and what to read before the interview.",
    icon: (
      <>
        <path d="M5 4h10l4 4v12H5z" />
        <path d="M15 4v4h4M8 13l2.5 2.5L16 10" />
      </>
    ),
  },
  {
    title: "Shareable views",
    body: "Copy a link to any filtered view, like Senior PM roles paying $200k+, and send it to a friend.",
    icon: (
      <>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      </>
    ),
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** First name, last name and email, sent to Kit (see kit.ts). */
function SignupForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const signup = { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() };
    if (!signup.firstName || !signup.lastName) return setProblem("Add your first and last name.");
    if (!EMAIL_RE.test(signup.email)) return setProblem("That email doesn't look right.");
    setProblem(null);
    setState("sending");
    try {
      await subscribe(signup);
      setState("done");
    } catch (err) {
      setState("idle");
      setProblem(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  if (state === "done") {
    return (
      <div className="lp-signup lp-signup-done" role="status">
        <p className="lp-done-title">You're in, {firstName.trim()}.</p>
        <p className="lp-fine">Check your inbox to confirm your email. The first Monday email comes this week.</p>
      </div>
    );
  }

  return (
    <form className="lp-signup" onSubmit={submit} noValidate>
      <p className="lp-signup-title">Get your week on the board, every Monday</p>
      <div className="lp-names">
        <input
          aria-label="First name"
          placeholder="First name"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          aria-label="Last name"
          placeholder="Last name"
          autoComplete="family-name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
      </div>
      <input
        aria-label="Email address"
        type="email"
        inputMode="email"
        placeholder="you@work.com"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button className="lp-btn lp-btn-accent" type="submit" disabled={state === "sending" || !KIT_FORM_ID}>
        {state === "sending" ? "Signing you up…" : "Sign up free"}
      </button>
      {problem && (
        <p className="lp-err" role="alert">
          {problem}
        </p>
      )}
      <p className="lp-fine">
        {KIT_FORM_ID
          ? "Free. Unsubscribe any time; the board stays open either way."
          : "Signups aren't connected yet: set VITE_KIT_FORM_ID (see src/kit.ts)."}
      </p>
    </form>
  );
}

export default function LandingPage({ data, error }: { data: MapData | null; error: string | null }) {
  const [now] = useState(() => Date.now());
  const [level, setLevel] = useState<LevelId>(() => {
    const saved = store.get("lp.level");
    return LEVELS.some(([id]) => id === saved) ? (saved as LevelId) : "senior";
  });
  const [metro, setMetro] = useState<MetroId>(() => {
    const saved = store.get("lp.metro");
    return METROS.some(([id]) => id === saved) ? (saved as MetroId) : "all";
  });

  const roles = useMemo(() => (data ? landingRoles(data, now) : []), [data, now]);
  const pick = useMemo(() => slice(roles, level, metro), [roles, level, metro]);
  const all = useMemo(() => slice(roles, "all", "all"), [roles]);
  const payChart = useMemo(() => payByLevel(roles), [roles]);
  const liveSlugs = useMemo(() => new Set(roles.map((r) => r.companySlug)), [roles]);
  const companyCount = liveSlugs.size;
  const logos = useMemo(() => LANDING_LOGOS.filter(([slug]) => liveSlugs.has(slug)).slice(0, 40), [liveSlugs]);
  const newestAll = useMemo(
    () => roles.filter((r) => !r.isGhost && pay(r)).sort((a, b) => Date.parse(b.role.firstSeenAt) - Date.parse(a.role.firstSeenAt)).slice(0, 3),
    [roles],
  );
  const oldestGhosts = useMemo(() => {
    const days = (r: LandingRole) => {
      const since = openSince(roleDate(r.role), r.role.repostedFrom);
      return since == null ? 0 : Math.floor((now - since) / DAY_MS);
    };
    // Well-known companies make the point better than an obscure one.
    const famous = new Set(LANDING_LOGOS.map(([slug]) => slug));
    return roles
      .filter((r) => r.isGhost && famous.has(r.companySlug))
      .map((r) => ({ r, days: days(r) }))
      .sort((a, b) => b.days - a.days)
      .slice(0, 2);
  }, [roles, now]);

  const updated = data ? new Date(data.generatedAt) : null;
  const updatedLabel = updated
    ? updated.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;
  const ghostShare = all.open > 0 ? all.ghost / all.open : 0;
  const payMax = Math.max(300_000, ...payChart.map((p) => p.pay));
  const board = "#/jobs";

  const pickLevel = (v: LevelId) => {
    setLevel(v);
    store.set("lp.level", v);
  };
  const pickMetro = (v: MetroId) => {
    setMetro(v);
    store.set("lp.metro", v);
  };

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="#/welcome">
            <span className="lp-brand-mark" aria-hidden="true">
              T
            </span>
            Tolara Scout
          </a>
          <nav className="lp-nav-links" aria-label="Sections">
            <a href="#/jobs">Job board</a>
            <a href="#/map">Map</a>
          </nav>
          <a className="lp-btn lp-btn-sm lp-nav-cta" href={board}>
            Open the board <span className="lp-arr">→</span>
          </a>
        </div>
      </header>

      <div className="lp-hero">
        <div className="lp-ribbon" aria-hidden="true" />
        <div className="lp-wrap lp-hero-grid">
          <div className="lp-hero-copy">
            <span className="lp-kicker">
              <b>FREE</b> Updated daily from {data ? fmt(companyCount) : "hundreds of"} companies' career sites
            </span>
            <h1>
              Every real PM job. <span className="lp-soft">None of the ghosts.</span>
            </h1>
            <p className="lp-lede">
              A free map and job board of {data ? `all ${fmt(all.open)}` : "every"} open product manager roles in the US. See
              the pay band when it's posted, a match score for your experience, and a flag on postings that have sat open
              for months.
            </p>
            <div className="lp-hero-ctas">
              <a className="lp-btn" href={board}>
                Open the job board <span className="lp-arr">→</span>
              </a>
              <a className="lp-btn lp-btn-ghost" href="#/map">
                See the map
              </a>
            </div>
          </div>

          <div className="lp-card">
            <div className="lp-card-head">
              <p className="lp-card-title">What's open for you</p>
              <span className="lp-card-note">{updatedLabel ? `Live · ${updatedLabel}` : "Loading…"}</span>
            </div>
            <div className="lp-picks">
              <label className="lp-pick">
                <span>Your level</span>
                <select value={level} onChange={(e) => pickLevel(e.target.value as LevelId)}>
                  {LEVELS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="lp-pick">
                <span>Where</span>
                <select value={metro} onChange={(e) => pickMetro(e.target.value as MetroId)}>
                  {METROS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="lp-preview" aria-live="polite">
              {error ? (
                <p className="lp-headline">Couldn't load today's roles.</p>
              ) : !data ? (
                <p className="lp-headline">Loading today's roles…</p>
              ) : (
                <>
                  <p className="lp-headline" key={`${level}-${metro}`}>
                    {pick.open === 0 ? (
                      <>
                        No open {LEVEL_WORD[level]} roles {metroWords(metro)} right now.
                      </>
                    ) : (
                      <>
                        <span className="lp-n">{fmt(pick.live)}</span> live {LEVEL_WORD[level]} roles {metroWords(metro)}
                      </>
                    )}
                  </p>
                  <div className="lp-mstats">
                    <div className="lp-mstat">
                      <b>+{fmt(pick.fresh)}</b>
                      <small>new in {data.changes.windowDays} days</small>
                    </div>
                    <div className="lp-mstat lp-money">
                      <b>{pick.medianPayTop ? k(pick.medianPayTop) : "—"}</b>
                      <small>median top of band</small>
                    </div>
                    <div className="lp-mstat lp-ghost">
                      <b>{fmt(pick.ghost)}</b>
                      <small>possible ghosts</small>
                    </div>
                  </div>
                  {pick.newest.length > 0 && (
                    <ul className="lp-roles">
                      {pick.newest.map((r) => (
                        <li key={r.role.id}>
                          <a href={roleHref(r.companySlug, r.role.id)}>
                            <span className="lp-t">
                              <b>{r.role.title}</b>
                              <span>
                                {r.companyName} · {place(r, metro)}
                              </span>
                            </span>
                            {pay(r) && <span className="lp-p">{pay(r)}</span>}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
            <SignupForm />
            <div className="lp-card-foot">
              <a className="lp-see" href={boardLink(level, metro)}>
                {/* The board has no city filter, so only an "Anywhere" pick
                    opens to exactly these roles and can promise a count. */}
                {data && metro === "all" && pick.live > 0
                  ? `Or see these ${fmt(pick.live)} roles now`
                  : `Or see ${LEVEL_WORD[level]} roles on the board now`}{" "}
                <span className="lp-arr">→</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      {data && (
        <div className="lp-stats">
          <div className="lp-wrap lp-stats-row" aria-label={`Last ${data.changes.windowDays} days of PM hiring`}>
            <div className="lp-stat">
              <span className="lp-big lp-new">+{fmt(data.changes.added)}</span>
              <p>PM roles opened in the last {data.changes.windowDays} days</p>
            </div>
            <div className="lp-stat">
              <span className="lp-big lp-gone">−{fmt(data.changes.closed)}</span>
              <p>taken down in the same week</p>
            </div>
            <div className="lp-stat">
              <span className="lp-big lp-ghosts">{fmt(all.ghost)}</span>
              <p>open 90+ days or reposted: possible ghosts</p>
            </div>
          </div>
        </div>
      )}

      {logos.length > 0 && (
        <div className="lp-wrap lp-logos">
          <span className="lp-logos-label">Hiring PMs right now, read daily from their own career sites</span>
          <ul className="lp-logo-grid">
            {logos.map(([slug, name, d]) => (
              <li key={slug} className="lp-logo-tile">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d={d} />
                </svg>
                <span>{name}</span>
              </li>
            ))}
          </ul>
          <span className="lp-logos-more">
            + {fmt(Math.max(0, companyCount - logos.length))} more, from seed-stage startups to the Fortune 500
          </span>
        </div>
      )}

      <section className="lp-sec">
        <div className="lp-wrap">
          <p className="lp-label">On the board</p>
          <h2>Three things other job boards don't show you.</h2>
          <p className="lp-sec-lede">
            Most job boards show everything that was ever posted. Tolara Scout shows what's live today, what it pays, and
            what's probably a ghost.
          </p>
          <div className="lp-shots">
            <div className="lp-shot">
              <span className="lp-tag lp-new">+ Updated daily</span>
              <h3>Every live role, newest first</h3>
              <p>Filter by level, pay, industry and remote, on a map or a list.</p>
              <div className="lp-ui">
                <ul className="lp-mini">
                  {newestAll.map((r) => (
                    <li key={r.role.id}>
                      <b>{r.role.title}</b>
                      <span>
                        {r.companyName} · {place(r)}
                      </span>
                      <em>{pay(r)}</em>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="lp-shot">
              <span className="lp-tag lp-money">$ Pay check</span>
              <h3>What each role pays</h3>
              <p>The posted band, and how it ranks against roles at the same level.</p>
              <div className="lp-ui">
                <figure className="lp-pay">
                  <figcaption>Typical top of posted band, by level</figcaption>
                  <ul>
                    {payChart.map((p) => (
                      <li key={p.level}>
                        <span>{p.label}</span>
                        <span className="lp-pb">
                          <i style={{ width: `${(p.pay / payMax) * 100}%` }} />
                        </span>
                        <span className="lp-pv">{k(p.pay)}</span>
                      </li>
                    ))}
                  </ul>
                </figure>
              </div>
            </div>
            <div className="lp-shot">
              <span className="lp-tag lp-ghost">👻 Ghost watch</span>
              <h3>Postings that aren't hiring</h3>
              <p>Open 90+ days, or taken down and reposted. Hide them with one filter.</p>
              <div className="lp-ui">
                {oldestGhosts.map(({ r, days }) => (
                  <div className="lp-ghost-row" key={r.role.id}>
                    <b>
                      {r.role.title} · {r.companyName}
                    </b>
                    <span className="lp-gtag">Open {days} days</span>
                  </div>
                ))}
                <div className="lp-meter">
                  <span style={{ width: `${Math.round(ghostShare * 100)}%` }} />
                </div>
                <small className="lp-meter-note">{Math.round(ghostShare * 100)}% of open US PM roles today</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-sec lp-sec-tight">
        <div className="lp-wrap lp-features">
          <div className="lp-features-intro">
            <p className="lp-label">Features</p>
            <h2>Everything on the board.</h2>
            <p className="lp-sec-lede">All of it free, updated daily.</p>
            <a className="lp-btn" href={board}>
              Open the job board <span className="lp-arr">→</span>
            </a>
          </div>
          <ul className="lp-feats">
            {FEATURES.map((f) => (
              <li className="lp-feat" key={f.title}>
                <span className="lp-feat-ic">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    {f.icon}
                  </svg>
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-closer">
        <div className="lp-wrap">
          <h2>Stop applying to ghosts.</h2>
          <p>{data ? `${fmt(all.live)} live PM roles, checked every day.` : "Live PM roles, checked every day."} Free.</p>
          <a className="lp-btn" href={board}>
            Open the job board <span className="lp-arr">→</span>
          </a>
        </div>
      </section>

      <footer className="lp-wrap lp-footer">
        <span>Tolara Scout{updatedLabel ? ` · Figures from the ${updatedLabel} update` : ""}</span>
        <span>
          {data ? `${fmt(all.open)} open roles at ${fmt(companyCount)} companies` : ""}
        </span>
      </footer>
    </div>
  );
}
