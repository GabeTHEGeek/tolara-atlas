import { useEffect, useRef, useState } from "react";
import type { VoiceEntry } from "../voice/useVoiceAgent.js";
import type { VoiceStatus } from "../voice/transport.js";
import VoiceWaveform from "./VoiceWaveform.js";

interface VoicePanelProps {
  available: boolean;
  transportName: string;
  provider: { ready: boolean; detail: string } | null;
  status: VoiceStatus;
  entries: VoiceEntry[];
  partial: string;
  error: string | null;
  muted: boolean;
  setMuted: (m: boolean) => void;
  handsFree: boolean;
  setHandsFree: (on: boolean) => void;
  listen: () => void;
  stop: () => void;
  ask: (text: string) => void;
  clear: () => void;
  inputLevel: () => number;
  outputLevel: () => number;
  /** Reports how much of the map the dock is covering, so it can pan clear. */
  onHeightChange?: (px: number) => void;
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Ask me something",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export default function VoicePanel(props: VoicePanelProps) {
  const { available, provider, status, entries, partial, error, muted, handsFree } = props;
  const [open, setOpen] = useState(false);
  // Collapsed keeps the conversation running with just the waveform and
  // controls -- zoomed into a city the full dock covers the pins it was
  // asked to show.
  const [collapsed, setCollapsed] = useState(false);
  const [typed, setTyped] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries, partial]);

  // Measured rather than assumed: the dock grows with the transcript, and a
  // hardcoded height would be wrong the moment anything changes.
  const report = props.onHeightChange;
  useEffect(() => {
    const el = panelRef.current;
    if (!report) return;
    if (!el || !open) {
      report(0);
      return;
    }
    const observer = new ResizeObserver(() => report(el.getBoundingClientRect().height + 20));
    observer.observe(el);
    report(el.getBoundingClientRect().height + 20);
    return () => {
      observer.disconnect();
      report(0);
    };
  }, [open, collapsed, report]);

  if (!open) {
    return (
      <button className="voice-fab" onClick={() => setOpen(true)} aria-label="Open the voice copilot" title="Voice copilot">
        <span aria-hidden="true">🎙</span>
      </button>
    );
  }

  const busy = status === "thinking" || status === "speaking";

  return (
    <aside ref={panelRef} className={`voice-panel${collapsed ? " is-collapsed" : ""}`} aria-label="Voice copilot">
      <div className="voice-header">
        <div>
          <h2>Copilot</h2>
          {!collapsed && (
            <p className="voice-sub">
              {provider ? (provider.ready ? provider.detail : `Not configured — ${provider.detail}`) : "Checking…"}
            </p>
          )}
        </div>
        <div className="voice-header-actions">
          <button
            className="voice-collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand the copilot" : "Collapse the copilot"}
            title={collapsed ? "Expand" : "Collapse — keeps listening, uncovers the map"}
          >
            {collapsed ? "▲" : "▼"}
          </button>
          <button className="company-panel-close" onClick={() => { props.stop(); setOpen(false); }} aria-label="Close">
            ×
          </button>
        </div>
      </div>

      {provider && !provider.ready && (
        <p className="voice-note voice-note-warn">
          Set a provider key in <code>.env</code> to enable it — see <code>server/agent/providers.ts</code>.
        </p>
      )}

      {!collapsed && (
      <div className="voice-log" ref={logRef}>
        {entries.length === 0 && (
          <p className="voice-note">
            Try: “take me to New York”, “show me senior roles paying over two hundred thousand”, “tell me about Airbnb”,
            or open a role and ask “what are they hiring for?”
          </p>
        )}
        {entries.map((entry, i) => (
          <div key={i} className={`voice-turn is-${entry.role}`}>
            <p className="voice-text">{entry.content}</p>
            {/* What the app actually did — shown so a wrong action is
                visible and correctable, not mysterious. */}
            {entry.did && entry.did.length > 0 && (
              <ul className="voice-did">
                {entry.did.map((d, j) => (
                  <li key={j}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {partial && <p className="voice-partial">{partial}</p>}
      </div>
      )}

      {error && <p className="voice-note voice-note-warn">{error}</p>}

      <VoiceWaveform status={status} inputLevel={props.inputLevel} outputLevel={props.outputLevel} />

      <div className="voice-controls">
        {/* Hands-free keeps the mic open across turns; the mic stays gated
            while the agent thinks and speaks so it doesn't hear itself. */}
        <button
          className={`voice-mic${handsFree ? " is-handsfree" : ""}${status === "listening" ? " is-live" : ""}`}
          onClick={() => (handsFree ? props.setHandsFree(false) : props.setHandsFree(true))}
          disabled={!available || (provider ? !provider.ready : false)}
          title={available ? "Keep listening — no clicking between turns" : "This browser has no speech recognition"}
        >
          {handsFree ? "■ Stop listening" : "🎙 Start conversation"}
        </button>
        <span className="voice-status">{handsFree ? STATUS_LABEL[status] : STATUS_LABEL[status]}</span>
        <button className="voice-toggle" onClick={() => props.setMuted(!muted)} title="Mute spoken replies">
          {muted ? "🔇" : "🔊"}
        </button>
      </div>

      {handsFree && (
        <p className="voice-note voice-hint">
          {status === "listening"
            ? "Go ahead — just talk. I'll keep listening between answers."
            : status === "thinking"
              ? "Mic paused while I look that up."
              : status === "speaking"
                ? "Mic paused while I answer, so I don't hear myself."
                : "Hands-free is on."}
        </p>
      )}

      {!handsFree && available && (
        <button
          className="voice-once"
          onClick={() => (status === "listening" ? props.stop() : props.listen())}
          disabled={busy || (provider ? !provider.ready : false)}
        >
          {status === "listening" ? "Cancel" : "Or ask just once"}
        </button>
      )}

      {/* Typing is the fallback when the mic is unavailable, and the way to
          test the agent without talking out loud. */}
      {!collapsed && (
      <form
        className="voice-type"
        onSubmit={(e) => {
          e.preventDefault();
          const text = typed.trim();
          if (!text || busy) return;
          setTyped("");
          props.ask(text);
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={available ? "…or type it" : "Type here (no mic in this browser)"}
          disabled={provider ? !provider.ready : false}
        />
        <button type="submit" disabled={!typed.trim() || busy}>
          Send
        </button>
      </form>
      )}

      {entries.length > 0 && !collapsed && (
        <button className="filter-clear voice-clear" onClick={props.clear}>
          Clear conversation
        </button>
      )}
    </aside>
  );
}
