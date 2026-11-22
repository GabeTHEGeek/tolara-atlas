import { TIER_CLASS, openQuiz, useRoleScore, useScores } from "../scores.js";

/**
 * "Your match" on role prep: the score and what each part of it came from,
 * from this browser's match quiz or (on the owner's machine) the resume
 * matcher. Only for analysed roles -- otherwise it renders nothing.
 */
export default function MatchCard({ roleId }: { roleId: number }) {
  const score = useRoleScore(roleId);
  const { source } = useScores();
  if (!score) return null;

  // Categories with no preference behind them weren't part of the score.
  const counted = score.categories.filter((c) => c.counted);

  return (
    <section className="card card--wide match-card">
      <div className="match-head">
        <h2 className="card-label">Your match</h2>
        <span className={`match-badge match-badge--${TIER_CLASS[score.tier]}`}>
          {score.score} · {score.tier}
        </span>
      </div>
      {score.capped && <p className="match-capped">Capped: {score.capped}</p>}
      <ul className="match-list">
        {counted.map((c) => (
          <li key={c.id} className="match-row">
            <span className="match-name">{c.label}</span>
            <span className="match-bar" aria-hidden="true">
              <span style={{ width: `${(c.points / c.max) * 100}%` }} />
            </span>
            <span className="match-points">
              {c.points}/{c.max}
            </span>
            <p className="match-why">{c.evidence}</p>
          </li>
        ))}
      </ul>
      {source === "quiz" && (
        <p className="match-source">
          From your quiz answers.{" "}
          <button type="button" className="link-button" onClick={() => openQuiz()}>
            Edit answers
          </button>
        </p>
      )}
    </section>
  );
}
