import { useEffect, useState } from "react";
import { QUESTIONS } from "../../server/match/onboarding.js";
import { ARCHETYPES, DEFAULT_QUIZ, readQuiz, type Archetype, type QuizAnswers } from "../quizMatch.js";
import { openQuiz, setQuizAnswers } from "../scores.js";

/**
 * The match quiz: a minute of questions in place of a resume. Answers stay
 * in this browser and every analysed role is scored against them here (see
 * quizMatch.ts). The preference questions are the matcher's own onboarding
 * questions (server/match/onboarding.ts), rendered as they are.
 */

const YEARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as Archetype[];
const MAX_PRIMARY = 3;

// The onboarding copy was written for the resume flow.
const LABEL_OVERRIDES: Record<string, string> = { resume: "Match my experience" };

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export default function MatchQuiz({ onSaved }: { onSaved?: () => void }) {
  const saved = readQuiz();
  const [q, setQ] = useState<QuizAnswers>(saved ?? DEFAULT_QUIZ);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof QuizAnswers>(key: K, value: QuizAnswers[K]) => setQ((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openQuiz(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickMulti = (id: "levels" | "locations" | "alsoConsider", option: string) => {
    let next = toggle(q[id], option);
    // "Match my experience" / "Anywhere" are the no-preference answers: they
    // can't be combined with specific picks.
    const none = id === "levels" ? "resume" : id === "locations" ? "anywhere" : null;
    if (none) next = option === none ? (next.includes(none) ? [none] : []) : next.filter((x) => x !== none);
    if (id !== "alsoConsider" && next.length === 0 && none) next = [none];
    set(id, next);
  };

  const submit = async () => {
    setSaving(true);
    await setQuizAnswers(q);
    setSaving(false);
    openQuiz(false);
    onSaved?.();
  };

  const clear = async () => {
    await setQuizAnswers(null);
    openQuiz(false);
  };

  return (
    <div className="quiz-backdrop" onClick={(e) => e.target === e.currentTarget && openQuiz(false)}>
      <div className="quiz" role="dialog" aria-modal="true" aria-labelledby="quiz-title">
        <header className="quiz-head">
          <div>
            <h2 id="quiz-title">Get your match score</h2>
            <p className="quiz-sub">
              A minute of questions, and every role gets a score for how well it fits you. Your answers stay in this browser.
            </p>
          </div>
          <button type="button" className="quiz-close" onClick={() => openQuiz(false)} aria-label="Close">
            ×
          </button>
        </header>

        <div className="quiz-body">
          <h3 className="quiz-section">Your experience</h3>

          <label className="quiz-field">
            <span>Years working as a product manager</span>
            <select value={q.pmYears} onChange={(e) => set("pmYears", Number(e.target.value))}>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y === 0 ? "Less than a year" : y === 15 ? "15 or more" : `${y} ${y === 1 ? "year" : "years"}`}
                </option>
              ))}
            </select>
          </label>

          <label className="quiz-field">
            <span>Years running product at a company you founded</span>
            <select value={q.founderYears} onChange={(e) => set("founderYears", Number(e.target.value))}>
              {YEARS.slice(0, 9).map((y) => (
                <option key={y} value={y}>
                  {y === 0 ? "None" : `${y} ${y === 1 ? "year" : "years"}`}
                </option>
              ))}
            </select>
          </label>

          <div className="quiz-field">
            <span>
              What kind of products have been your main focus? <em>Up to {MAX_PRIMARY}</em>
            </span>
            <div className="quiz-chips">
              {ARCHETYPE_IDS.map((a) => {
                const on = q.primary.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    className={`job-pill${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    disabled={!on && q.primary.length >= MAX_PRIMARY}
                    onClick={() => setQ((p) => ({ ...p, primary: toggle(p.primary, a), some: p.some.filter((x) => x !== a) }))}
                  >
                    {ARCHETYPES[a]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="quiz-field">
            <span>
              Any you've shipped some work in, but not as your main focus? <em>Optional</em>
            </span>
            <div className="quiz-chips">
              {ARCHETYPE_IDS.filter((a) => !q.primary.includes(a)).map((a) => {
                const on = q.some.includes(a);
                return (
                  <button key={a} type="button" className={`job-pill${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => set("some", toggle(q.some, a))}>
                    {ARCHETYPES[a]}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="quiz-field">
            <span>
              Product areas you've worked in <em>Optional, comma separated</em>
            </span>
            <input
              type="text"
              value={q.domains}
              placeholder="e.g. payments, healthcare, creator tools"
              onChange={(e) => set("domains", e.target.value)}
            />
          </label>

          <div className="quiz-row">
            <label className="quiz-field">
              <span>Machine learning depth</span>
              <select value={q.mlDepth} onChange={(e) => set("mlDepth", e.target.value as QuizAnswers["mlDepth"])}>
                <option value="none">None</option>
                <option value="applied">Applied AI (LLM features, agents, prompts)</option>
                <option value="deep">Deep ML (training models, ML infrastructure)</option>
              </select>
            </label>
            <label className="quiz-field">
              <span>Have you managed other PMs?</span>
              <select value={q.managedPeople ? "yes" : "no"} onChange={(e) => set("managedPeople", e.target.value === "yes")}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>

          <h3 className="quiz-section">What you're looking for</h3>

          {QUESTIONS.map((question) =>
            question.multi ? (
              <div key={question.id} className="quiz-field">
                <span>{question.prompt}</span>
                <div className="quiz-chips">
                  {question.options.map((o) => {
                    const list = q[question.id] as string[];
                    const on = list.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        className={`job-pill${on ? " is-on" : ""}`}
                        aria-pressed={on}
                        onClick={() => pickMulti(question.id as "levels" | "locations" | "alsoConsider", o.id)}
                      >
                        {LABEL_OVERRIDES[o.id] ?? o.label.replace(" -- no preference", "")}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <label key={question.id} className="quiz-field">
                <span>{question.prompt}</span>
                <select value={q[question.id] as string} onChange={(e) => set(question.id, e.target.value)}>
                  {question.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ),
          )}

          <p className="quiz-note">
            Without a resume we can't check each role's must-haves, so Requirements is scored only on the years each role asks
            for.
          </p>
        </div>

        <footer className="quiz-foot">
          {saved && (
            <button type="button" className="btn btn-secondary" onClick={clear}>
              Clear my answers
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || q.primary.length === 0}>
            {saving ? "Scoring…" : q.primary.length === 0 ? "Pick your main focus first" : "See my matches"}
          </button>
        </footer>
      </div>
    </div>
  );
}
