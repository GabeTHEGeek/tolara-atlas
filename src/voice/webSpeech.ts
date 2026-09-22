/**
 * voice/webSpeech.ts
 * VoiceTransport on the browser's built-in SpeechRecognition and
 * speechSynthesis. Free, no key, no per-word cost, no audio leaving the
 * machine until the transcript is sent to our own endpoint.
 *
 * What it doesn't do, versus a realtime audio API: no barge-in (you can't
 * talk over it), and the voice is the OS's. Comprehension is unaffected --
 * this only turns sound into a string; understanding happens in the model
 * behind /api/agent, which sees the same free-form sentence either way.
 *
 * Chrome and Edge implement SpeechRecognition (webkit-prefixed); Firefox
 * does not, which `available` reports so the UI can explain rather than
 * silently do nothing.
 */

import type { VoiceTransport } from "./transport.js";

// Chrome throws if start() is called from inside onend, so restarts go
// through a timer. The resume delay after a spoken reply is longer, to let
// the speaker audio decay before the mic is live again.
const RESTART_DELAY_MS = 120;
const RESUME_DELAY_MS = 350;
const MAX_CONSECUTIVE_FAILURES = 4;
// Room noise arrives as one- or two-character fragments.
const MIN_UTTERANCE_CHARS = 3;

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class WebSpeechTransport implements VoiceTransport {
  readonly name = "Web Speech (browser, free)";
  onTranscript: ((text: string) => void) | null = null;
  onPartial: ((text: string) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  private recognition: SpeechRecognitionLike | null = null;
  private stopping = false;
  private muted = false;
  // Hands-free state. `suspended` is set while the agent is thinking or
  // speaking, so the recogniser doesn't hear the reply and treat it as the
  // next question.
  private continuous = false;
  private suspended = false;
  // Chrome ends a recognition session on its own after a few seconds of
  // silence even with continuous=true, so hands-free means restarting it
  // repeatedly. A run of failures (permission revoked, no device) would
  // otherwise spin forever.
  private consecutiveFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // Mic metering for the waveform. Separate from SpeechRecognition, which
  // reports words but never amplitude -- so the visual needs its own stream.
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private frequencyData: Uint8Array | null = null;
  // Output envelope: bumped on each spoken word boundary, decayed on read.
  private speechEnvelope = 0;
  private speechEnvelopeAt = 0;

  get available(): boolean {
    return recognitionCtor() !== null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.cancelSpeech();
  }

  setContinuous(on: boolean): void {
    this.continuous = on;
    if (!on) {
      this.clearRestart();
      this.suspended = false;
    }
  }

  suspend(): void {
    this.suspended = true;
    this.clearRestart();
    this.stopRecognition();
  }

  resume(): void {
    this.suspended = false;
    if (this.continuous) this.scheduleRestart(RESUME_DELAY_MS);
  }

  private clearRestart(): void {
    if (this.restartTimer != null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /**
   * Restart after a beat rather than immediately: calling start() inside the
   * onend handler throws InvalidStateError in Chrome, and after a spoken
   * reply the delay also lets the audio tail die down before the mic is
   * live again.
   */
  private scheduleRestart(delayMs: number): void {
    this.clearRestart();
    if (!this.continuous || this.suspended) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.continuous || this.suspended || this.recognition) return;
      void this.start();
    }, delayMs);
  }

  /** Stops the recogniser only -- leaves mic metering and hands-free intact. */
  private stopRecognition(): void {
    if (!this.recognition) return;
    this.stopping = true;
    this.recognition.abort();
    this.recognition = null;
  }

  /**
   * Opens a metering-only stream. Failure is non-fatal: recognition asks for
   * its own permission and works regardless; only the waveform goes flat.
   */
  private async startMetering(): Promise<void> {
    if (this.analyser) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      context.createMediaStreamSource(stream).connect(analyser);
      this.micStream = stream;
      this.audioContext = context;
      this.analyser = analyser;
      this.frequencyData = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      // Permission denied or no device; the waveform stays idle.
    }
  }

  /** Releases the mic so the browser's recording indicator goes out. */
  private stopMetering(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    void this.audioContext?.close().catch(() => {});
    this.micStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.frequencyData = null;
  }

  inputLevel(): number {
    if (!this.analyser || !this.frequencyData) return 0;
    this.analyser.getByteFrequencyData(this.frequencyData as Uint8Array<ArrayBuffer>);
    // Mean of the low/mid bins, where speech energy sits, normalized and
    // curved so quiet speech still visibly moves the bars.
    const bins = Math.min(48, this.frequencyData.length);
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += this.frequencyData[i];
    return Math.min(1, (sum / bins / 255) * 1.8);
  }

  outputLevel(): number {
    if (this.speechEnvelope === 0) return 0;
    // Decay since the last word boundary, so the bars fall between words
    // instead of sitting flat-topped through the whole reply.
    const elapsed = performance.now() - this.speechEnvelopeAt;
    return Math.max(0, this.speechEnvelope * Math.exp(-elapsed / 220));
  }

  async start(): Promise<void> {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.onError?.("This browser has no speech recognition. Chrome or Edge will work.");
      return;
    }
    // Speaking and listening at once makes the mic hear the assistant.
    if (!this.continuous) this.cancelSpeech();
    this.clearRestart();
    this.stopRecognition();
    await this.startMetering();

    const recognition = new Ctor();
    recognition.lang = "en-US";
    // In hands-free mode the recogniser stays open across pauses; otherwise
    // it captures a single utterance and stops, which is what the
    // click-to-talk button wants.
    recognition.continuous = this.continuous;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = "";
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else partial += result[0].transcript;
      }
      if (partial) this.onPartial?.(partial.trim());
      const complete = finalText.trim();
      if (complete) {
        // A clean result means the mic and permissions are healthy.
        this.consecutiveFailures = 0;
        // Hands-free hears room noise as one- and two-character fragments;
        // sending those to the model wastes a turn and confuses the
        // conversation history.
        if (complete.length >= MIN_UTTERANCE_CHARS) this.onTranscript?.(complete);
      }
    };

    recognition.onerror = (event) => {
      // "aborted" and "no-speech" are ordinary -- the user stopped, or said
      // nothing into an open mic. In hands-free mode especially, no-speech
      // fires constantly and is not an error worth showing.
      if (event.error === "aborted" || event.error === "no-speech") return;
      // Anything else counts against the restart budget, so a revoked
      // permission stops the loop instead of retrying forever.
      this.consecutiveFailures += 1;
      if (event.error === "not-allowed") {
        this.continuous = false;
        this.onError?.("Microphone access was blocked. Allow it in the address bar and try again.");
        return;
      }
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.continuous = false;
        this.onError?.(`Speech recognition kept failing (${event.error}). Hands-free is off.`);
        return;
      }
      this.onError?.(`Speech recognition error: ${event.error}`);
    };

    recognition.onend = () => {
      this.recognition = null;
      const wasStopping = this.stopping;
      this.stopping = false;
      if (wasStopping) return;
      // Chrome closes the session after a stretch of silence. In hands-free
      // mode that's not the end of listening, it's a reconnect.
      if (this.continuous && !this.suspended) {
        this.scheduleRestart(RESTART_DELAY_MS);
        return;
      }
      this.onEnd?.();
    };

    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.continuous = false;
    this.suspended = false;
    this.clearRestart();
    this.stopMetering();
    if (!this.recognition) return;
    this.stopping = true;
    this.recognition.abort();
    this.recognition = null;
  }

  async speak(text: string): Promise<void> {
    if (this.muted || !text || !("speechSynthesis" in window)) return;
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      // Each word boundary re-energizes the envelope the waveform reads, so
      // the bars move in time with the actual speech rather than on a timer.
      utterance.onboundary = () => {
        this.speechEnvelope = 0.55 + Math.random() * 0.45;
        this.speechEnvelopeAt = performance.now();
      };
      const finish = () => {
        this.speechEnvelope = 0;
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      this.speechEnvelope = 0.6;
      this.speechEnvelopeAt = performance.now();
      window.speechSynthesis.speak(utterance);
    });
  }

  cancelSpeech(): void {
    this.speechEnvelope = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}
