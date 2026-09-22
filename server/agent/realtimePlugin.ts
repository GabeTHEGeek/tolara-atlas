/**
 * agent/realtimePlugin.ts
 *   POST /api/voice/session -> an ephemeral client secret for WebRTC
 *   POST /api/voice/tool    -> runs one tool the realtime model asked for
 *
 * The other transport (src/voice/webSpeech.ts) sends a transcript to
 * /api/agent and our own model loop decides what to do. Realtime inverts
 * that: OpenAI holds the conversation and the audio, and emits tool calls
 * to the BROWSER over a data channel. But the tools read SQLite, which the
 * browser can't touch -- so the browser relays each call here, we run it,
 * and it posts the result back into the session.
 *
 * The API key never leaves this file. The browser gets a short-lived
 * `ek_...` secret minted per session, which is the whole point of
 * /v1/realtime/client_secrets.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { getDb } from "../db/client.js";
import { ACTION_TOOLS, TOOL_SCHEMAS, runTool } from "./tools.js";
import { voiceInstructions } from "./agent.js";

const DEFAULT_MODEL = "gpt-realtime-2.1-mini";

/**
 * Not every model the client_secrets endpoint accepts can actually hold a
 * WebRTC call. gpt-live-1 mints a token happily and then fails the
 * handshake with "not supported in realtime mode" -- so the check happens
 * here, where the error can say something useful, rather than after the
 * browser has set up a peer connection for nothing.
 */
function looksRealtimeCapable(model: string): boolean {
  return /realtime/i.test(model);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

/** Mints the short-lived secret the browser uses to open its WebRTC session. */
async function createSession(res: ServerResponse, screen: Record<string, unknown>) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return send(res, 400, { error: "OPENAI_API_KEY is not set" });

  const model = process.env.TOLARA_REALTIME_MODEL || DEFAULT_MODEL;
  if (!looksRealtimeCapable(model)) {
    return send(res, 400, {
      error:
        `TOLARA_REALTIME_MODEL is "${model}", which the Realtime API doesn't accept for a live call ` +
        `(it mints a token and then fails the handshake). Use a gpt-realtime-* model, e.g. ${DEFAULT_MODEL}.`,
    });
  }

  const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        // Same grounding rules as the text agent -- the model must look a
        // role up before describing it, because it has never seen these
        // postings. See agent.ts.
        instructions: voiceInstructions(screen as never),
        tools: TOOL_SCHEMAS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
        audio: {
          input: {
            // Turn detection decides when you've stopped talking, and it is
            // the single biggest lever on how fast a reply feels.
            //
            // semantic_vad waits to judge whether you've finished a THOUGHT,
            // which is kinder to rambling speech and adds a noticeable beat
            // to every short question. server_vad just waits for silence, so
            // "take me to Austin" gets answered as soon as you stop.
            // Default is server_vad with a 500ms tail; set TOLARA_VAD=semantic
            // to trade snappiness back for patience.
            turn_detection:
              (process.env.TOLARA_VAD ?? "server").toLowerCase() === "semantic"
                ? { type: "semantic_vad", interrupt_response: true }
                : {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                    interrupt_response: true,
                  },
          },
          output: { voice: "marin" },
        },
      },
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("[api/voice/session]", resp.status, text.slice(0, 300));
    return send(res, 502, { error: "Couldn't start a voice session", detail: text.slice(0, 200) });
  }
  // Only the ephemeral secret and its expiry reach the browser.
  const json = JSON.parse(text) as { value?: string; expires_at?: number };
  send(res, 200, { value: json.value, expiresAt: json.expires_at, model });
}

/** Runs one tool for the realtime session and says whether the UI should act. */
async function runRelayedTool(res: ServerResponse, body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return send(res, 400, { error: "Missing tool name" });
  const args = (body.arguments ?? {}) as Record<string, unknown>;
  const screen = (body.screen ?? {}) as { openRole?: { id?: number; companySlug?: string } };

  try {
    const outcome = await runTool(getDb(), name, args, {
      openRoleId: screen.openRole?.id ?? null,
      openCompanySlug: screen.openRole?.companySlug ?? null,
    });
    send(res, 200, {
      result: outcome.result,
      action: outcome.action && ACTION_TOOLS.has(outcome.action.name) ? outcome.action : null,
    });
  } catch (err) {
    console.error("[api/voice/tool]", err);
    send(res, 500, { result: { error: "Tool failed" }, action: null });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }

  if (req.url?.startsWith("/session")) return createSession(res, (body.screen ?? {}) as Record<string, unknown>);
  // Instructions carry "what is on screen right now", which goes stale the
  // moment the user navigates. The browser re-fetches them and pushes a
  // session.update, so the model isn't reasoning about a map that moved ten
  // turns ago. Built here so there is one copy of the prompt, not two.
  if (req.url?.startsWith("/instructions")) {
    return send(res, 200, { instructions: voiceInstructions((body.screen ?? {}) as never) });
  }
  if (req.url?.startsWith("/tool")) return runRelayedTool(res, body);
  send(res, 404, { error: "Unknown voice endpoint" });
}

export function realtimeApi(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse) => void handle(req, res);
  return {
    name: "tolara-realtime-api",
    configureServer(server) {
      server.middlewares.use("/api/voice", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/voice", middleware);
    },
  };
}
