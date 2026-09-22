/**
 * voice/realtime.ts
 * VoiceTransport over OpenAI's Realtime API — speech to speech, no
 * transcribe-then-think-then-speak round trip.
 *
 * What this buys over webSpeech.ts:
 *   - barge-in: you can talk over it, because it is listening while it
 *     speaks (server-side VAD with interrupt_response)
 *   - a real voice instead of the OS speech synthesiser
 *   - a REAL output waveform. speechSynthesis plays straight to the output
 *     device and can't be metered; here the reply arrives as a MediaStream,
 *     so outputLevel() is an actual amplitude reading rather than an
 *     envelope faked from word boundaries.
 *
 * The model lives in OpenAI's cloud and emits tool calls to us over the
 * data channel. Those tools read SQLite, which the browser can't, so each
 * call is relayed to /api/voice/tool and the result is posted back into the
 * session. UI actions (fly the map, set filters) come back alongside and
 * are handed to the same applyAction path the other transport uses.
 *
 * The API key is never here: /api/voice/session mints a short-lived
 * `ek_...` client secret per connection.
 */

import type { VoiceTransport } from "./transport.js";

const REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
// Tools answer in milliseconds; the one that blocks is an explicit profile
// load at six seconds. Past this something is wrong and the conversation
// should hear about it rather than wait.
const TOOL_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
  ]);
}

export interface RealtimeHooks {
  /** Runs a tool server-side; returns what to tell the model and what the UI should do. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<{ result: unknown; action: { name: string; args: Record<string, unknown> } | null }>;
  /** Current screen state, sent when the session opens. */
  screen: () => Record<string, unknown>;
  /** A completed assistant utterance, for the transcript. */
  onReply: (text: string) => void;
  /** A UI action the model asked for. */
  onAction: (action: { name: string; args: Record<string, unknown> }) => void;
  onSpeakingChange: (speaking: boolean) => void;
}

function rms(analyser: AnalyserNode, buffer: Uint8Array): number {
  analyser.getByteFrequencyData(buffer as Uint8Array<ArrayBuffer>);
  const bins = Math.min(48, buffer.length);
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += buffer[i];
  return Math.min(1, (sum / bins / 255) * 1.8);
}

export class RealtimeTransport implements VoiceTransport {
  readonly name = "OpenAI Realtime (speech to speech)";
  onTranscript: ((text: string) => void) | null = null;
  onPartial: ((text: string) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private inAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private inBuffer: Uint8Array | null = null;
  private outBuffer: Uint8Array | null = null;
  private muted = false;
  private connecting = false;
  private lastScreenKey = "";
  private lastReply = "";
  // Accumulates the assistant's transcript deltas for the current reply.
  private replyText = "";

  constructor(private hooks: RealtimeHooks) {}

  get available(): boolean {
    return typeof RTCPeerConnection !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  // Realtime is inherently continuous -- server-side VAD decides when a turn
  // ends -- so these exist to satisfy the interface, not to change behaviour.
  setContinuous(): void {}
  suspend(): void {}
  resume(): void {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audioEl) this.audioEl.muted = muted;
  }

  inputLevel(): number {
    return this.inAnalyser && this.inBuffer ? rms(this.inAnalyser, this.inBuffer) : 0;
  }

  /** A genuine reading off the model's audio track, unlike the Web Speech transport. */
  outputLevel(): number {
    return this.outAnalyser && this.outBuffer ? rms(this.outAnalyser, this.outBuffer) : 0;
  }

  async start(): Promise<void> {
    if (this.pc || this.connecting) return;
    this.connecting = true;
    try {
      const tokenResp = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screen: this.hooks.screen() }),
      });
      const token = (await tokenResp.json()) as { value?: string; model?: string; error?: string };
      if (!tokenResp.ok || !token.value) throw new Error(token.error ?? "Couldn't start a voice session");

      const pc = new RTCPeerConnection();
      this.pc = pc;

      // The model's voice arrives as a track; routing it through an
      // AudioContext is what makes a true output waveform possible.
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.muted = this.muted;
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!this.audioEl || !stream) return;
        this.audioEl.srcObject = stream;
        const context = this.context ?? new AudioContext();
        this.context = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        context.createMediaStreamSource(stream).connect(analyser);
        this.outAnalyser = analyser;
        this.outBuffer = new Uint8Array(analyser.frequencyBinCount);
      };

      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of this.micStream.getTracks()) pc.addTrack(track, this.micStream);
      const context = this.context ?? new AudioContext();
      this.context = context;
      const inAnalyser = context.createAnalyser();
      inAnalyser.fftSize = 256;
      inAnalyser.smoothingTimeConstant = 0.7;
      context.createMediaStreamSource(this.micStream).connect(inAnalyser);
      this.inAnalyser = inAnalyser;
      this.inBuffer = new Uint8Array(inAnalyser.frequencyBinCount);

      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (event) => {
        // Both the parse and the handler can throw; an unhandled rejection
        // here is invisible and leaves the session wedged.
        try {
          void this.handleEvent(JSON.parse(event.data as string)).catch((err) => {
            this.onError?.(`Voice event failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } catch {
          // A malformed event is not worth dropping the call for.
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await fetch(`${REALTIME_URL}?model=${encodeURIComponent(token.model ?? "")}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
      });
      if (!answer.ok) {
        // The body carries the actual reason and is worth every character --
        // "handshake failed (400)" cost an hour that
        // "Model X is not supported in realtime mode" would have saved.
        const detail = await answer.text().catch(() => "");
        let message = detail.slice(0, 200);
        try {
          message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // Not JSON; the raw text is still better than a bare status.
        }
        throw new Error(`Realtime handshake failed (${answer.status}): ${message}`);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    } catch (err) {
      this.stop();
      this.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.connecting = false;
    }
  }

  private send(payload: unknown): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(payload));
  }

  /**
   * Push fresh "what is on screen" into the live session.
   *
   * Without this the model answers from the state captured when the call
   * started -- it will insist nothing is open long after you opened
   * something, because its instructions were written once and never
   * revised. Skipped when nothing material changed, since every update
   * costs a round trip.
   */
  async updateScreen(): Promise<void> {
    if (this.channel?.readyState !== "open") return;
    const screen = this.hooks.screen();
    const key = JSON.stringify(screen);
    if (key === this.lastScreenKey) return;
    this.lastScreenKey = key;
    try {
      const resp = await fetch("/api/voice/instructions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screen }),
      });
      const { instructions } = (await resp.json()) as { instructions?: string };
      if (instructions) this.send({ type: "session.update", session: { type: "realtime", instructions } });
    } catch {
      // A missed refresh degrades the answer; it shouldn't drop the call.
    }
  }

  private async handleEvent(event: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (event.type) {
      // What the user said, once the server's VAD has settled the turn.
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "").trim();
        if (text) this.onTranscript?.(text);
        break;
      }
      case "response.output_audio_transcript.delta": {
        this.replyText += String(event.delta ?? "");
        this.onPartial?.(this.replyText);
        break;
      }
      case "response.output_audio_transcript.done": {
        const text = String(event.transcript ?? this.replyText).trim();
        this.replyText = "";
        if (text && text !== this.lastReply) {
          this.lastReply = text;
          this.hooks.onReply(text);
        }
        break;
      }
      case "response.created":
        this.hooks.onSpeakingChange(true);
        break;
      case "response.done": {
        this.hooks.onSpeakingChange(false);
        const output = ((event.response as { output?: unknown[] })?.output ?? []) as Array<{
          type?: string;
          name?: string;
          call_id?: string;
          arguments?: string;
        }>;
        // Tool calls are dispatched from HERE ONLY. Handling them from the
        // per-call event as well meant two outputs and two continuations for
        // one turn, and the model said the same thing twice.
        let hadToolCalls = false;
        for (const item of output) {
          if (item.type !== "function_call" || !item.name || !item.call_id) continue;
          hadToolCalls = true;
          await this.dispatchToolCall(item.name, item.call_id, item.arguments ?? "{}");
        }
        // Exactly one continuation per response that used tools.
        if (hadToolCalls) this.send({ type: "response.create" });
        break;
      }
      case "error":
        this.onError?.(String((event.error as { message?: string })?.message ?? "Realtime error"));
        break;
    }
  }

  private handledCalls = new Set<string>();

  /** Runs one tool and posts its output back. Returns false if already done. */
  private async dispatchToolCall(name: string, callId: string, rawArgs: string): Promise<boolean> {
    if (!name || !callId || this.handledCalls.has(callId)) return false;
    this.handledCalls.add(callId);
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }

    // A function_call_output MUST go back for every call, whatever happens.
    // The model is blocked waiting for it: if the relay throws -- server
    // error, network blip, a tool that raises -- and we never reply, the
    // conversation simply stops. No error, no speech, nothing. That is the
    // freeze, and it is worse than any failure we could report.
    let result: unknown;
    try {
      const outcome = await withTimeout(this.hooks.runTool(name, args), TOOL_TIMEOUT_MS);
      result = outcome.result;
      if (outcome.action) this.hooks.onAction(outcome.action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { error: `That didn't work: ${message}. Tell the user plainly and carry on.` };
      this.onError?.(`Tool "${name}" failed: ${message}`);
    }

    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    });
    // Whatever just changed on screen should reach the model before it
    // speaks about it.
    void this.updateScreen();
    return true;
  }

  stop(): void {
    this.channel?.close();
    this.pc?.close();
    this.micStream?.getTracks().forEach((t) => t.stop());
    void this.context?.close().catch(() => {});
    if (this.audioEl) this.audioEl.srcObject = null;
    this.channel = null;
    this.pc = null;
    this.micStream = null;
    this.audioEl = null;
    this.context = null;
    this.inAnalyser = this.outAnalyser = null;
    this.inBuffer = this.outBuffer = null;
    this.replyText = "";
    this.handledCalls.clear();
    this.lastScreenKey = "";
    this.lastReply = "";
    this.onEnd?.();
  }

  /** The model speaks for itself; nothing to synthesise locally. */
  async speak(): Promise<void> {}

  cancelSpeech(): void {
    this.send({ type: "response.cancel" });
  }
}
