/**
 * agent/agentPlugin.ts
 *   POST /api/agent        { utterance, history, screen } -> { reply, actions }
 *   GET  /api/agent/status -> which provider is configured, without the key
 *
 * Same shape as api/intelligencePlugin.ts: a Vite middleware in dev and
 * preview, and the exact handler a serverless function would wrap on a
 * static deploy. The API key only ever lives here, never in the browser.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { getDb } from "../db/client.js";
import { runAgent, type AgentTurn, type ScreenState } from "./agent.js";
import { ProviderError, describeProvider } from "./providers.js";

const MAX_UTTERANCE_CHARS = 500;

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith("/status")) return send(res, 200, describeProvider());
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  let body: { utterance?: unknown; history?: unknown; screen?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }

  const utterance = typeof body.utterance === "string" ? body.utterance.trim().slice(0, MAX_UTTERANCE_CHARS) : "";
  if (!utterance) return send(res, 400, { error: "Missing utterance" });

  const history = Array.isArray(body.history) ? (body.history as AgentTurn[]).filter((t) => t && typeof t.content === "string") : [];
  const screen = (body.screen ?? { view: "map" }) as ScreenState;

  try {
    const result = await runAgent(getDb(), utterance, history, screen);
    send(res, 200, result);
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error("[api/agent]", err.message);
      // 429 on a free tier is expected, not broken -- say so specifically so
      // the UI can tell the user to wait rather than that it failed.
      if (err.status === 429) {
        return send(res, 429, { error: "rate_limited", reply: "I'm being rate limited — give me a few seconds and ask again." });
      }
      return send(res, err.status && err.status < 500 ? 400 : 502, {
        error: "provider_error",
        reply: err.retryable ? "I couldn't reach the model just then — try again?" : err.message,
      });
    }
    console.error("[api/agent]", err);
    send(res, 500, { error: "agent_failed", reply: "Something went wrong on my side." });
  }
}

export function agentApi(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse) => void handle(req, res);
  return {
    name: "tolara-agent-api",
    configureServer(server) {
      server.middlewares.use("/api/agent", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/agent", middleware);
    },
  };
}
