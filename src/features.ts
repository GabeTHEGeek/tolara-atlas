/**
 * features.ts
 * Switches for features that are built but not shown by default.
 *
 * VOICE_ENABLED: the voice copilot (VoicePanel). Off unless .env.local sets
 *   VITE_ENABLE_VOICE=1
 * It needs the dev server's /api/agent endpoints and an AI provider key, so
 * it only works on your own machine. Those keys are read on the server
 * (process.env in server/agent) and never reach the browser; this switch
 * holds no secret, only whether the panel appears.
 */

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export const VOICE_ENABLED = env.VITE_ENABLE_VOICE === "1";
