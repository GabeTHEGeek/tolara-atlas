import { useEffect, useRef, useState } from "react";
import { TIER_CLASS, type Tier } from "../scores.js";

/**
 * A role's match score as a ring that fills to the score, with the number
 * counting up in the middle. It starts when the ring scrolls into view, so
 * rows further down the list animate as you reach them. One CSS custom
 * property (--p, registered in styles.css) drives both the arc and the
 * number; reduced-motion users see the final ring at once.
 */
export default function MatchRing({
  score,
  tier,
  href,
  size = 44,
}: {
  score: number;
  tier: Tier;
  href?: string;
  size?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const value = Math.max(0, Math.min(100, Math.round(score)));
  const style = { "--p": shown ? value : 0, width: size, height: size } as React.CSSProperties;
  const label = `Match ${value} out of 100: ${tier}`;
  const body = (
    <>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="match-ring-track" cx="22" cy="22" r="18" />
        <circle className="match-ring-arc" cx="22" cy="22" r="18" />
      </svg>
      <span className="match-ring-num" aria-hidden="true" />
    </>
  );
  const className = `match-ring match-ring--${TIER_CLASS[tier]}${size >= 56 ? " match-ring--lg" : ""}`;

  return href ? (
    <a ref={(el) => (ref.current = el)} className={className} style={style} href={href} title={`${label}. Open the role for why.`} aria-label={label}>
      {body}
    </a>
  ) : (
    <span ref={(el) => (ref.current = el)} className={className} style={style} title={label} role="img" aria-label={label}>
      {body}
    </span>
  );
}
