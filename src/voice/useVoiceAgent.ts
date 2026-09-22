/**
 * voice/useVoiceAgent.ts
 * Wires a VoiceTransport to /api/agent and applies whatever the agent
 * decided to do.
 *
 * The actions it performs are the app's own state, untouched by this
 * feature: RoleFilters from src/filters.ts, the pin selection App.tsx
 * already holds, and the routes in src/router.ts. The agent never
 * manipulates the DOM -- it fills in structs the UI already consumes, which
 * is why nothing here can put the app into a state a click couldn't.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocationPinData, MapData } from "../types.js";
import { EMPTY_FILTERS, type RemoteMode, type RoleFilters } from "../filters.js";
import { SENIORITY_TIERS, type Seniority } from "../types.js";
import { roleHref } from "../router.js";
import { WebSpeechTransport } from "./webSpeech.js";
import { RealtimeTransport } from "./realtime.js";
import type { VoiceStatus, VoiceTransport } from "./transport.js";

export interface AgentAction {
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceEntry {
  role: "user" | "assistant";
  content: string;
  // What the app actually did, shown under the reply so a wrong action is
  // visible rather than mysterious.
  did?: string[];
}

export interface VoiceAgentHandlers {
  mapData: MapData | null;
  /** Press the open role page's "Load company intelligence" button. */
  loadIntelligence: (companySlug: string) => void;
  filters: RoleFilters;
  setFilters: (f: RoleFilters) => void;
  selectPin: (pin: LocationPinData) => void;
  flyToPin: (pin: LocationPinData) => void;
  zoomMap: (direction: "in" | "out" | "reset", steps: number) => void;
  /** Closes the company panel, role drawer and side panels. */
  clearPanels: () => void;
  screen: { view: "map" | "role"; selectedCompany?: { name: string; slug: string } | null; openRole?: { id: number; title: string; companySlug: string } | null; visibleRoleCount?: number };
  /** The pin currently in focus — the office of the open role, if any. */
  currentPinId: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Models hand back whichever form they feel like -- asked for a state code,
// Gemini answers "New York" as often as "NY" -- so full names are folded to
// codes before comparing. Only the states the map actually has pins in
// would be strictly necessary; the full list costs nothing and means a new
// office city never silently fails to resolve.
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", districtofcolumbia: "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", newhampshire: "NH", newjersey: "NJ",
  newmexico: "NM", newyork: "NY", northcarolina: "NC", northdakota: "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  rhodeisland: "RI", southcarolina: "SC", southdakota: "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  westvirginia: "WV", wisconsin: "WI", wyoming: "WY",
};

function stateCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = norm(raw);
  if (n.length === 2) return n.toUpperCase();
  return STATE_CODES[n] ?? null;
}

/**
 * The pins a place name refers to, biggest first.
 *
 * The state is a tiebreaker, never a hard filter: "New York" the city and
 * "New York" the state arrive in the same argument about half the time, and
 * an unrecognised state shouldn't mean the map refuses to move. Matching
 * cities win; if the state also matches, they rank higher.
 */
function findCityPins(pins: LocationPinData[], city: string, state?: string): LocationPinData[] {
  const wanted = norm(city);
  if (!wanted) return [];
  const code = stateCode(state);

  const cityMatches = pins.filter((p) => {
    const c = norm(p.city ?? "");
    return c === wanted || c.startsWith(wanted) || wanted.startsWith(c);
  });

  return cityMatches.sort((a, b) => {
    const aState = code && norm(a.state ?? "").toUpperCase() === code ? 0 : 1;
    const bState = code && norm(b.state ?? "").toUpperCase() === code ? 0 : 1;
    return aState - bState || b.roleCount - a.roleCount;
  });
}

export function useVoiceAgent(handlers: VoiceAgentHandlers) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [entries, setEntries] = useState<VoiceEntry[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [handsFree, setHandsFreeState] = useState(false);
  // Where the map was last sent. Without this the agent flies somewhere and
  // immediately forgets it did -- "what's hiring there?" is the commonest
  // follow-up in a hands-free conversation and it has nothing to resolve
  // "there" against.
  const [mapFocus, setMapFocus] = useState<{ city: string; state: string } | null>(null);
  const mapFocusRef = useRef(mapFocus);
  mapFocusRef.current = mapFocus;
  // Guards against a transcript arriving mid-request: the recogniser is
  // suspended while we work, but a result already in flight can still land.
  const busyRef = useRef(false);
  const [provider, setProvider] = useState<{ ready: boolean; detail: string } | null>(null);

  // Which transport is in use is a server-side setting
  // (TOLARA_VOICE_TRANSPORT), fetched with the provider status below.
  const [useRealtime, setUseRealtime] = useState<boolean | null>(null);

  const transport = useMemo<VoiceTransport & { setMuted?: (m: boolean) => void }>(() => {
    if (useRealtime !== true) return new WebSpeechTransport();
    // Realtime holds the conversation itself: it emits tool calls, we run
    // them server-side and post the results back. Same tools, same actions,
    // same grounding -- only the audio path differs.
    return new RealtimeTransport({
      runTool: async (name, args) => {
        const resp = await fetch("/api/voice/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, arguments: args, screen: handlersRef.current.screen }),
        });
        const data = (await resp.json()) as { result: unknown; action: AgentAction | null };
        return data;
      },
      screen: () => ({ ...handlersRef.current.screen, mapFocus: mapFocusRef.current }),
      onReply: (text) => setEntries((prev) => [...prev, { role: "assistant", content: text }]),
      onAction: (action) => {
        const did = applyActionRef.current?.(action);
        if (did) setEntries((prev) => [...prev, { role: "assistant", content: "", did: [did] }]);
      },
      onSpeakingChange: (speaking) => setStatus(speaking ? "speaking" : "listening"),
    });
  }, [useRealtime]);

  // applyAction is defined below; the transport closes over it via a ref so
  // the memo above doesn't have to depend on it.
  const applyActionRef = useRef<((a: AgentAction) => string | null) | null>(null);
  // Handlers change every render; the transport callbacks are registered
  // once, so they read the latest through a ref instead.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const entriesRef = useRef<VoiceEntry[]>([]);
  entriesRef.current = entries;

  useEffect(() => {
    fetch("/api/agent/status")
      .then((r) => r.json())
      .then((d) => {
        setProvider({ ready: Boolean(d.ready), detail: String(d.detail ?? "") });
        setUseRealtime(Boolean(d.realtime));
      })
      .catch(() => {
        setProvider({ ready: false, detail: "Agent endpoint unreachable" });
        setUseRealtime(false);
      });
  }, []);

  useEffect(() => transport.setMuted?.(muted), [transport, muted]);

  // Realtime bakes "what is on screen" into the session's instructions, so
  // it has to be re-pushed whenever the user navigates -- otherwise the
  // model spends the whole call describing the screen as it was when the
  // call started.
  const screenKey = JSON.stringify(handlers.screen);
  useEffect(() => {
    const withUpdate = transport as { updateScreen?: () => Promise<void> };
    void withUpdate.updateScreen?.();
  }, [transport, screenKey, mapFocus]);

  /** Performs one agent action; returns a human description, or null if it couldn't. */
  const applyAction = useCallback((action: AgentAction): string | null => {
    const h = handlersRef.current;
    const pins = h.mapData?.pins ?? [];

    switch (action.name) {
      case "flyToPlace": {
        const city = String(action.args.city ?? "");
        const state = action.args.state ? String(action.args.state) : undefined;
        const matches = findCityPins(pins, city, state);
        // Server-side validation should have caught this, but filters can
        // hide every pin in a city -- saying nothing beats a silent no-op.
        if (matches.length === 0) return null;
        // Moving to a different city leaves any open panel describing the
        // old one, which reads as the app ignoring you.
        h.clearPanels();
        h.flyToPin(matches[0]);
        setMapFocus({ city: matches[0].city ?? city, state: matches[0].state ?? "" });
        return `Moved to ${matches[0].city}, ${matches[0].state}`;
      }
      case "zoomMap": {
        const raw = String(action.args.direction ?? "in");
        const direction = raw === "out" ? "out" : raw === "reset" ? "reset" : "in";
        const steps = Math.min(4, Math.max(1, Number(action.args.steps) || 1));
        if (direction === "reset") {
          // Framing the whole country while a city's panel is still open is
          // incoherent -- the panel describes somewhere you're no longer at.
          h.clearPanels();
          setMapFocus(null);
        }
        h.zoomMap(direction, steps);
        return direction === "reset" ? "Zoomed out to the whole US" : `Zoomed ${direction}`;
      }
      case "showCompany": {
        const slug = String(action.args.companySlug ?? "");
        const companyPins = pins.filter((p) => p.companySlug === slug);
        if (companyPins.length === 0) return null;

        // Which of the company's offices to open. Biggest-first is right
        // from the map, and wrong when you're reading a role in Austin and
        // it hauls you to headquarters in San Francisco. So: the office of
        // the role on screen wins, then wherever the map is already
        // looking, then the biggest.
        const focus = mapFocusRef.current;
        const pick =
          (h.currentPinId ? companyPins.find((p) => p.id === h.currentPinId) : undefined) ??
          (focus
            ? companyPins.find(
                (p) => norm(p.city ?? "") === norm(focus.city) && (!focus.state || norm(p.state ?? "") === norm(focus.state)),
              )
            : undefined) ??
          [...companyPins].sort((a, b) => b.roleCount - a.roleCount)[0];

        h.selectPin(pick);
        // Only move the camera if we're not already there -- opening a panel
        // shouldn't re-fly the map you're already looking at.
        if (pick.id !== h.currentPinId) h.flyToPin(pick);
        setMapFocus({ city: pick.city ?? "", state: pick.state ?? "" });
        return `Opened ${pick.companyName}${pick.city ? ` — ${pick.city}, ${pick.state}` : ""}`;
      }
      case "openRole": {
        const slug = String(action.args.companySlug ?? "");
        const roleId = Number(action.args.roleId);
        if (!slug || !Number.isFinite(roleId)) return null;
        // The previous company's panel has nothing to do with this role.
        h.clearPanels();
        window.location.hash = roleHref(slug, roleId);
        return "Opened the role";
      }
      case "setFilters": {
        const next: RoleFilters = { ...h.filters, seniority: new Set(h.filters.seniority) };
        const described: string[] = [];
        if (Array.isArray(action.args.seniority)) {
          const tiers = (action.args.seniority as string[]).filter((t): t is Seniority =>
            (SENIORITY_TIERS as readonly string[]).includes(t),
          );
          if (tiers.length > 0) {
            next.seniority = new Set(tiers);
            described.push(tiers.join(", "));
          }
        }
        if (typeof action.args.minSalary === "number") {
          next.minSalary = action.args.minSalary;
          described.push(`$${Math.round(action.args.minSalary / 1000)}k+`);
        }
        if (typeof action.args.postedWithinDays === "number") {
          next.postedWithinDays = action.args.postedWithinDays;
          described.push(`last ${action.args.postedWithinDays} days`);
        }
        if (typeof action.args.newOnly === "boolean") {
          next.newOnly = action.args.newOnly;
          if (action.args.newOnly) described.push("new only");
        }
        if (typeof action.args.remote === "string" && ["all", "office-only", "remote-only"].includes(action.args.remote)) {
          next.remote = action.args.remote as RemoteMode;
          described.push(action.args.remote);
        }
        if (described.length === 0) return null;
        h.setFilters(next);
        return `Filtered to ${described.join(" · ")}`;
      }
      case "loadIntelligence": {
        const slug = String(action.args.companySlug ?? "");
        if (!slug) return null;
        h.loadIntelligence(slug);
        return "Loading their company profile";
      }
      case "clearFilters": {
        h.setFilters({ ...EMPTY_FILTERS, seniority: new Set() });
        return "Cleared the filters";
      }
      default:
        return null;
    }
  }, []);

  applyActionRef.current = applyAction;

  const ask = useCallback(
    async (utterance: string) => {
      // Drop anything that arrives while a turn is already in progress --
      // in hands-free mode that's usually the tail of the same sentence.
      if (busyRef.current) return;
      busyRef.current = true;
      // Deaf while thinking and speaking, so the reply doesn't become the
      // next question.
      transport.suspend();

      setPartial("");
      setEntries((prev) => [...prev, { role: "user", content: utterance }]);
      setStatus("thinking");
      setError(null);

      try {
        const resp = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            utterance,
            history: entriesRef.current.slice(-6).map((e) => ({ role: e.role, content: e.content })),
            screen: { ...handlersRef.current.screen, filters: null, mapFocus: mapFocusRef.current },
          }),
        });
        const data = (await resp.json()) as { reply?: string; actions?: AgentAction[]; error?: string };
        const reply = data.reply ?? "Something went wrong.";
        const did = (data.actions ?? []).map(applyAction).filter((d): d is string => d !== null);

        setEntries((prev) => [...prev, { role: "assistant", content: reply, did }]);
        if (!resp.ok) setError(data.error === "rate_limited" ? "Rate limited — wait a moment." : (data.error ?? null));

        setStatus("speaking");
        await transport.speak(reply);
        setStatus(handsFreeRef.current ? "listening" : "idle");
      } catch {
        setError("Couldn't reach the agent.");
        setStatus("error");
      } finally {
        busyRef.current = false;
        // Back to listening for the next thing said, with no click.
        transport.resume();
      }
    },
    [applyAction, transport],
  );

  // Read inside `ask`, which is memoised and would otherwise capture a
  // stale value.
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;

  useEffect(() => {
    transport.onTranscript = (text) => {
      if (useRealtime) {
        // Realtime answers for itself; the transcript is only for display.
        setEntries((prev) => [...prev, { role: "user", content: text }]);
        setPartial("");
        return;
      }
      void ask(text);
    };
    transport.onPartial = (text) => setPartial(text);
    transport.onError = (message) => {
      setError(message);
      setStatus("error");
    };
    // In hands-free mode the recogniser reconnects itself, so a session
    // ending isn't the end of listening.
    transport.onEnd = () => setStatus((s) => (s === "listening" && !handsFreeRef.current ? "idle" : s));
    return () => {
      transport.onTranscript = null;
      transport.onPartial = null;
      transport.onError = null;
      transport.onEnd = null;
    };
  }, [transport, ask, useRealtime]);

  const listen = useCallback(async () => {
    setError(null);
    setStatus("listening");
    await transport.start();
  }, [transport]);

  const stop = useCallback(() => {
    setHandsFreeState(false);
    transport.stop();
    transport.cancelSpeech();
    setStatus("idle");
    setPartial("");
  }, [transport]);

  /** Hands-free: keep the mic open across turns instead of a click each time. */
  const setHandsFree = useCallback(
    async (on: boolean) => {
      setHandsFreeState(on);
      transport.setContinuous(on);
      if (on) {
        setError(null);
        setStatus("listening");
        await transport.start();
      } else {
        transport.stop();
        setStatus("idle");
        setPartial("");
      }
    },
    [transport],
  );

  // Passed as functions, not state: the waveform polls them per frame.
  const inputLevel = useCallback(() => transport.inputLevel(), [transport]);
  const outputLevel = useCallback(() => transport.outputLevel(), [transport]);

  return {
    available: transport.available,
    transportName: transport.name,
    realtime: useRealtime === true,
    inputLevel,
    outputLevel,
    provider,
    status,
    entries,
    partial,
    error,
    muted,
    setMuted,
    handsFree,
    setHandsFree,
    listen,
    stop,
    ask,
    clear: () => setEntries([]),
  };
}
