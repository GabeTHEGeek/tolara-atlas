import { useEffect, useRef, useState } from "react";
import { QUESTIONS } from "../../server/match/onboarding.js";
import { ARCHETYPES, DEFAULT_QUIZ, readQuiz, type Archetype, type QuizAnswers } from "../quizMatch.js";
import { openQuiz, setQuizAnswers } from "../scores.js";
import { guessFromResume, type ResumeGuess } from "../resumeGuess.js";
import { resumeText } from "../resumeText.js";

/**
 * The match quiz: a minute of questions in place of a resume. Answers stay
 * in this browser and every analysed role is scored against them here (see
 * quizMatch.ts). The preference questions are the matcher's own onboarding
 * questions (server/match/onboarding.ts), rendered as they are.
 *
 * Three short steps instead of one long form: your experience, what you've
 * worked on, what you're looking for. Next is held on step 2 until a main
 * focus is picked, since Domain match (the biggest category) needs one.
 */

const YEARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as Archetype[];
const MAX_PRIMARY = 3;
const STEPS = ["Your experience", "What you've worked on", "What you're looking for"] as const;

// The onboarding copy was written for the resume flow.
const LABEL_OVERRIDES: Record<string, string> = { resume: "Match my experience" };

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export default function MatchQuiz({ onSaved }: { onSaved?: () => void }) {
  const saved = readQuiz();
  const [q, setQ] = useState<QuizAnswers>(saved ?? DEFAULT_QUIZ);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);
  // Founder time counts at two-thirds toward PM years (candidate.ts); asked
  // as a yes/no first because "years at a company you founded" confused testers.
  const [founded, setFounded] = useState((saved?.founderYears ?? 0) > 0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Resume fill: read and guessed in this browser (resumeGuess.ts), never uploaded.
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [reading, setReading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [filled, setFilled] = useState<ResumeGuess | null>(null);
  const set = <K extends keyof QuizAnswers>(key: K, value: QuizAnswers[K]) => setQ((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openQuiz(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Each step starts at its top, with focus on its heading for screen readers and keyboards.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    headingRef.current?.focus();
  }, [step]);

  const toggleFounded = (on: boolean) => {
    setFounded(on);
    set("founderYears", on ? Math.max(1, q.founderYears) : 0);
  };

  const fillFrom = (text: string) => {
    const guess = guessFromResume(text);
    if (guess.jobs.length === 0 && guess.answers.primary.length === 0) {
      setResumeError("Couldn't find product jobs with dates in that text. Fill in the answers below instead.");
      return;
    }
    setQ((prev) => ({ ...prev, ...guess.answers }));
    setFounded(guess.answers.founderYears > 0);
    setFilled(guess);
    setPasting(false);
    setPasted("");
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setResumeError(null);
    setReading(true);
    try {
      fillFrom(await resumeText(file));
    } catch (e) {
      setResumeError(e instanceof Error ? e.message : "Couldn't read that file. Paste the text instead.");
    } finally {
      setReading(false);
    }
  };

  const last = step === STEPS.length - 1;
  const blocked = step === 1 && q.primary.length === 0;

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
        <div className="quiz-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          <span className="quiz-step-count">
            Step {step + 1} of {STEPS.length}
          </span>
          <span className="quiz-dots" aria-hidden="true">
            {STEPS.map((_, i) => (
              <i key={i} className={i < step ? "is-done" : i === step ? "is-on" : ""} />
            ))}
          </span>
        </div>

        <div className="quiz-body" ref={bodyRef}>
          <h3 className="quiz-section" ref={headingRef} tabIndex={-1}>
            {STEPS[step]}
          </h3>

          {step === 0 && (
            <>
              <div className="quiz-resume">
                {filled ? (
                  <p className="quiz-resume-done">
                    <strong>Filled in from your resume.</strong>{" "}
                    {filled.jobs.length > 0
                      ? `Found ${filled.jobs.length} product ${filled.jobs.length === 1 ? "job" : "jobs"}: ${filled.jobs
                          .map((j) => `${j.title} (${j.years} yrs)`)
                          .join("; ")}.`
                      : "No dated product jobs found, so check the years."}{" "}
                    It's a rough guess: check each answer on this step and the next.
                  </p>
                ) : (
                  <p>
                    <strong>Have a resume handy?</strong> We'll fill in this step and the next from it. It's read in this browser and
                    never uploaded.
                  </p>
                )}
                <div className="quiz-resume-actions">
                  <label className={`btn btn-secondary${reading ? " is-busy" : ""}`}>
                    {reading ? "Reading…" : filled ? "Use a different resume" : "Upload resume (PDF)"}
                    <input
                      type="file"
                      accept=".pdf,.txt,.md,application/pdf,text/plain"
                      hidden
                      disabled={reading}
                      onChange={(e) => {
                        void onFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {!pasting && (
                    <button type="button" className="quiz-link" onClick={() => setPasting(true)}>
                      or paste the text
                    </button>
                  )}
                </div>
                {pasting && (
                  <div className="quiz-paste">
                    <textarea
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      placeholder="Paste your resume here"
                      rows={6}
                      aria-label="Resume text"
                    />
                    <button type="button" className="btn btn-secondary" disabled={pasted.trim().length < 100} onClick={() => fillFrom(pasted)}>
                      Fill in my answers
                    </button>
                  </div>
                )}
                {resumeError && (
                  <p className="quiz-resume-error" role="alert">
                    {resumeError}
                  </p>
                )}
              </div>

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

              <label className="quiz-check">
                <input type="checkbox" checked={founded} onChange={(e) => toggleFounded(e.target.checked)} />
                <span>I've founded a company and led its product</span>
              </label>
              {founded && (
                <label className="quiz-field quiz-sub-field">
                  <span>How many years did you lead product there?</span>
                  <select value={q.founderYears} onChange={(e) => set("founderYears", Number(e.target.value))}>
                    {YEARS.slice(1, 9).map((y) => (
                      <option key={y} value={y}>
                        {`${y} ${y === 1 ? "year" : "years"}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="quiz-field">
                <span>Have you managed other PMs?</span>
                <select value={q.managedPeople ? "yes" : "no"} onChange={(e) => set("managedPeople", e.target.value === "yes")}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </label>
            </>
          )}

          {step === 1 && (
            <>
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

              <label className="quiz-field">
                <span>Machine learning depth</span>
                <select value={q.mlDepth} onChange={(e) => set("mlDepth", e.target.value as QuizAnswers["mlDepth"])}>
                  <option value="none">None</option>
                  <option value="applied">Applied AI (LLM features, agents, prompts)</option>
                  <option value="deep">Deep ML (training models, ML infrastructure)</option>
                </select>
              </label>
            </>
          )}

          {step === 2 && (
            <>
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
            </>
          )}
        </div>

        <footer className="quiz-foot">
          {saved && (
            <button type="button" className="btn btn-secondary quiz-clear" onClick={clear}>
              Clear my answers
            </button>
          )}
          <span className="quiz-nav">
            {step > 0 && (
              <button type="button" className="btn btn-secondary" onClick={() => setStep((n) => n - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || q.primary.length === 0}>
                {saving ? "Scoring…" : "See my matches"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => setStep((n) => n + 1)} disabled={blocked}>
                {blocked ? "Pick a main focus" : "Next"}
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
