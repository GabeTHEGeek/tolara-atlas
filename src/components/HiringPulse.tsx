import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A company's hiring trend as an animated line on a monitor-style screen:
 * PM roles open at the end of each week, so the line goes up when they're
 * hiring and down when roles close faster than they open. When the chart
 * scrolls into view the line draws itself left to right with a glowing dot
 * riding it, then the dot keeps pulsing at "now" like a heart monitor.
 * The beep (a tick per week as it draws, then one per pulse) is off by
 * default, one click to turn on, and remembered in this browser. Click the
 * screen to replay. Reduced-motion users get the finished line.
 */

type Week = { start: string; opened: number; closed: number; open: number };

const W = 380;
const H = 170;
const PAD = { l: 38, r: 14, t: 16, b: 14 };
const DRAW_MS = 2400;
const SOUND_KEY = "tolara.pulseSound";

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

let audio: AudioContext | null = null;
function tone(freq: number, peak: number, ms: number) {
  if (!audio || audio.state !== "running") return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}
const tick = () => tone(660, 0.05, 60);
const beep = () => tone(990, 0.12, 140);

function trend(weeks: Week[]) {
  const now = weeks[weeks.length - 1].open;
  const back = weeks[Math.max(0, weeks.length - 5)].open;
  const diff = now - back;
  const pct = back > 0 ? Math.round((diff / back) * 100) : diff > 0 ? 100 : 0;
  const span = Math.min(4, weeks.length - 1);
  if (Math.abs(pct) < 10 || Math.abs(diff) < 2) return { word: "Holding steady", arrow: "●", tone: "steady" as const, diff, span };
  return diff > 0
    ? { word: `Hiring up ${pct}%`, arrow: "▲", tone: "up" as const, diff, span }
    : { word: `Hiring down ${Math.abs(pct)}%`, arrow: "▼", tone: "down" as const, diff, span };
}

export default function HiringPulse({ weeks }: { weeks: Week[] }) {
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const [sound, setSound] = useState(readSound);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const [run, setRun] = useState(0); // bumps to replay the draw
  const [done, setDone] = useState(reduceMotion);
  const wrapRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const dotRef = useRef<SVGGElement>(null);
  const [seen, setSeen] = useState(false);

  const geo = useMemo(() => {
    const vals = weeks.map((w) => w.open);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = Math.max(1, (max - min) * 0.25);
    const lo = Math.max(0, min - pad);
    const hi = max + pad;
    const n = Math.max(1, weeks.length - 1);
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / n;
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const pts = vals.map((v, i) => [x(i), y(v)] as [number, number]);
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H - PAD.b}L${PAD.l},${H - PAD.b}Z`;
    return { pts, line, area, min, max, yMin: y(min), yMax: y(max) };
  }, [weeks]);

  // Start drawing the first time the chart is on screen.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (reduceMotion || !seen || weeks.length < 2) return;
    setDone(false);
    const { pts } = geo;
    const startX = pts[0][0];
    const endX = pts[pts.length - 1][0];
    let raf = 0;
    let passed = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DRAW_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      const x = startX + (endX - startX) * eased;
      let i = 1;
      while (i < pts.length - 1 && pts[i][0] < x) i++;
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const yv = x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      clipRef.current?.setAttribute("width", String(x + 4));
      dotRef.current?.setAttribute("transform", `translate(${x.toFixed(1)},${yv.toFixed(1)})`);
      while (passed < pts.length && pts[passed][0] <= x + 0.01) {
        if (soundRef.current) tick();
        passed++;
      }
      if (p < 1) raf = requestAnimationFrame(step);
      else setDone(true);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [geo, run, seen, reduceMotion, weeks.length]);

  const toggleSound = () => {
    const next = !sound;
    if (next) {
      audio ??= new AudioContext();
      void audio.resume().then(beep);
    }
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      /* private window */
    }
  };

  if (weeks.length < 2) {
    return (
      <div className="pulse pulse--empty">
        <p>We started tracking this company recently. Its hiring trend fills in week by week.</p>
      </div>
    );
  }

  const t = trend(weeks);
  const last = geo.pts[geo.pts.length - 1];
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const label = (w: Week) => `Week of ${fmt(w.start)}: ${w.open} open (${w.opened} opened, ${w.closed} closed)`;
  const nowOpen = weeks[weeks.length - 1].open;

  return (
    <div className={`pulse pulse--${t.tone}`} ref={wrapRef}>
      <div className="pulse-top">
        <span className="pulse-verdict">
          <span className="pulse-arrow" aria-hidden="true">
            {t.arrow}
          </span>
          {t.word}
        </span>
        <span className="pulse-readout">
          <strong>{nowOpen}</strong> open
          {t.diff !== 0 && (
            <span className="pulse-diff">
              {" "}
              {t.diff > 0 ? "+" : "−"}
              {Math.abs(t.diff)} in {t.span} wks
            </span>
          )}
        </span>
        <button type="button" className="pulse-sound" onClick={toggleSound} aria-pressed={sound} title={sound ? "Turn the beep off" : "Beep like a heart monitor"}>
          {sound ? "🔊" : "🔈"}
        </button>
      </div>
      <svg
        className="pulse-screen"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Open PM roles by week. ${t.word}. ${weeks.map(label).join(". ")}.`}
        onClick={() => !reduceMotion && setRun((r) => r + 1)}
      >
        <defs>
          <pattern id="pulse-grid" width={W / 12} height={H / 5} patternUnits="userSpaceOnUse">
            <path d={`M ${W / 12} 0 L 0 0 0 ${H / 5}`} className="pulse-gridline" />
          </pattern>
          <linearGradient id="pulse-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="pulse-fill-top" />
            <stop offset="100%" className="pulse-fill-bottom" />
          </linearGradient>
          <clipPath id="pulse-drawn">
            <rect ref={clipRef} x="0" y="0" width={reduceMotion ? W : 0} height={H} />
          </clipPath>
        </defs>
        <rect width={W} height={H} fill="url(#pulse-grid)" />
        <text x={PAD.l - 6} y={geo.yMax + 4} className="pulse-ylabel">
          {geo.max}
        </text>
        {geo.min !== geo.max && (
          <text x={PAD.l - 6} y={geo.yMin + 4} className="pulse-ylabel">
            {geo.min}
          </text>
        )}
        <g clipPath="url(#pulse-drawn)">
          <path d={geo.area} fill="url(#pulse-fill)" />
          <path d={geo.line} className="pulse-trace" />
          {geo.pts.map(([px, py], i) => (
            <circle key={i} cx={px} cy={py} r="2.6" className="pulse-point" />
          ))}
        </g>
        {done ? (
          <g transform={`translate(${last[0]},${last[1]})`}>
            {!reduceMotion && <circle r="6" className="pulse-ripple" onAnimationIteration={() => soundRef.current && beep()} />}
            <circle r="4.5" className="pulse-head" />
          </g>
        ) : (
          <g ref={dotRef} transform={`translate(${geo.pts[0][0]},${geo.pts[0][1]})`}>
            <circle r="4.5" className="pulse-head" />
          </g>
        )}
        {geo.pts.map(([px], i) => {
          const half = (W - PAD.l - PAD.r) / Math.max(1, weeks.length - 1) / 2;
          return (
            <rect key={i} x={px - half} y="0" width={half * 2} height={H} className="pulse-hit">
              <title>{label(weeks[i])}</title>
            </rect>
          );
        })}
      </svg>
      <div className="pulse-axis">
        <span>{fmt(weeks[0].start)}</span>
        <span>Open PM roles by week</span>
        <span>Now</span>
      </div>
    </div>
  );
}
