/**
 * features.ts
 * Switches for features that are built but not shown by default.
 *
 * PEOPLE_ENABLED: "Find people" (PeoplePanel), which searches LinkedIn for
 *   people to contact about a role. Off unless .env.local sets
 *   VITE_ENABLE_PEOPLE=1; it drives a signed-in browser on your own machine
 *   through the dev server, so it can't work on the hosted site.
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
export const PEOPLE_ENABLED = env.VITE_ENABLE_PEOPLE === "1";
