/**
 * voice/transport.ts
 * The seam between "how speech gets in and out" and "what the agent does".
 *
 * Everything above this interface -- the tool schemas, the grounding, the
 * actions the map performs -- is transport-agnostic. That's deliberate:
 * today's implementation is the browser's built-in Web Speech API, which is
 * free and costs nothing per word. A realtime speech-to-speech API (Gemini
 * Live, OpenAI Realtime) is a different implementation of THIS interface,
 * not a rewrite: it would capture audio, stream it to the provider, and
 * surface the same onTranscript/onReply events.
 *
 * The one thing a realtime transport changes is where the model lives: it
 * would hold the conversation itself and emit tool calls directly, so
 * `sendToAgent` would be wired to its function-call events instead of our
 * /api/agent round trip. The tool schemas in server/agent/tools.ts are
 * already in the shape both expect.
 */

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceTransport {
  /** Whether this transport can run in the current browser. */
  readonly available: boolean;
  readonly name: string;
  /** Begin capturing speech. Resolves once capture has actually started. */
  start(): Promise<void>;
  stop(): void;
  /**
   * Hands-free mode: keep listening across turns instead of one utterance
   * per click.
   *
   * The reason this isn't simply `recognition.continuous = true` is that
   * the assistant's reply comes out of the same speakers the microphone is
   * pointed at. Left open, the recogniser transcribes the reply and feeds
   * it back as the next question -- the agent talks to itself. So the
   * implementation has to suspend capture while it speaks and resume after,
   * which is what `suspend`/`resume` below are for.
   */
  setContinuous(on: boolean): void;
  /** Stop capturing without leaving hands-free mode (used while replying). */
  suspend(): void;
  /** Resume capturing after a suspend, if hands-free is still on. */
  resume(): void;
  /** Speak a reply. Resolves when finished (or immediately if muted). */
  speak(text: string): Promise<void>;
  /** Stop any in-progress speech, e.g. because the user started talking. */
  cancelSpeech(): void;
  /**
   * Current amplitude, 0..1, for the waveform.
   *
   * `inputLevel` is a real reading off the microphone (Web Audio analyser).
   * `outputLevel` is NOT real for this transport: speechSynthesis plays
   * straight to the output device and its audio can't be routed into Web
   * Audio, so the level is an envelope driven by the utterance's own word
   * boundary events -- real speech rhythm, synthesized amplitude. A
   * realtime audio transport owns its output stream and can return a true
   * reading here without anything above this interface changing.
   */
  inputLevel(): number;
  outputLevel(): number;
  /** A complete utterance from the user. */
  onTranscript: ((text: string) => void) | null;
  /** Words recognised so far, for live feedback while speaking. */
  onPartial: ((text: string) => void) | null;
  onError: ((message: string) => void) | null;
  onEnd: (() => void) | null;
}
