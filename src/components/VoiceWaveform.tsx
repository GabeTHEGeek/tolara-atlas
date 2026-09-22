import { useEffect, useRef } from "react";
import type { VoiceStatus } from "../voice/transport.js";

interface VoiceWaveformProps {
  status: VoiceStatus;
  // Polled each frame rather than passed as state: at 60fps a React render
  // per sample would thrash the whole tree for a purely visual effect.
  inputLevel: () => number;
  outputLevel: () => number;
}

const BAR_COUNT = 40;
const BAR_GAP = 3;
// Teal (--accent) while you talk, warmer while it talks back, so which way
// the conversation is flowing is readable at a glance.
const LISTEN_COLOR = [111, 224, 196] as const;
const SPEAK_COLOR = [245, 181, 68] as const;
const IDLE_COLOR = [95, 104, 117] as const;

export default function VoiceWaveform({ status, inputLevel, outputLevel }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Bar heights persist across frames so they ease toward the live level
  // instead of snapping -- the difference between "waveform" and "strobe".
  const barsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    let running = true;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      if (!running) return;
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);

      const state = statusRef.current;
      const speaking = state === "speaking";
      const listening = state === "listening";
      const level = speaking ? outputLevel() : listening ? inputLevel() : 0;
      const color = speaking ? SPEAK_COLOR : listening ? LISTEN_COLOR : IDLE_COLOR;

      const barWidth = (width - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
      const mid = height / 2;
      const bars = barsRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        // Distance from centre: the middle bars react most, so the shape
        // reads as a voice rather than an equalizer.
        const fromCentre = Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
        const envelope = Math.cos(fromCentre * Math.PI * 0.5) ** 1.4;
        // A travelling ripple keeps neighbouring bars from moving in
        // lockstep, which is what makes a bar meter look alive.
        const ripple = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(now / 130 + i * 0.55);
        const target = level * envelope * ripple;
        // Rise fast, fall slow -- speech attack is sharp, decay isn't.
        const current = bars[i];
        bars[i] = target > current ? current + (target - current) * 0.45 : current + (target - current) * 0.12;

        const amplitude = Math.max(0.012, bars[i]) * (height / 2 - 2);
        const x = i * (barWidth + BAR_GAP);
        const alpha = 0.35 + bars[i] * 0.65;
        ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
        ctx.beginPath();
        const radius = Math.min(barWidth / 2, 2);
        ctx.roundRect(x, mid - amplitude, barWidth, amplitude * 2, radius);
        ctx.fill();
      }

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [inputLevel, outputLevel]);

  return <canvas ref={canvasRef} className="voice-waveform" aria-hidden="true" />;
}
