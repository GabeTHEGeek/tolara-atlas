/**
 * contacts/contactsPlugin.ts
 *   GET  /api/contacts/status       -> { local: true, counts, job }
 *   GET  /api/contacts?role=<id>    -> { result, job } for one role
 *   POST /api/contacts/find {role}  -> starts a "Find people" run
 *
 * Dev server only (`npm run dev`), and only from this machine: it drives a
 * browser signed in to the owner's own LinkedIn, so there's deliberately no
 * preview or serverless counterpart. On a static build these paths don't
 * exist, which is how the UI knows to say "runs locally only".
 *
 * A run takes tens of seconds and the browser is one window, so there's
 * one job at a time; the page polls it for progress.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { getDb } from "../db/client.js";
import { ProviderError } from "../agent/providers.js";
import { LinkedInStop } from "./linkedin.js";
import { cachedContacts, cachedCounts, findPeople, type ContactsResult } from "./findPeople.js";

interface Job {
  roleId: number;
  state: "running" | "done" | "error" | "stopped";
  message: string;
  startedAt: string;
  result?: ContactsResult;
}

let job: Job | null = null;
// After a security check or restriction, refuse further runs until the dev
// server restarts: "don't retry" has to survive the owner clicking again.
let blocked: string | null = null;

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function start(roleId: number) {
  const current: Job = { roleId, state: "running", message: "Starting…", startedAt: new Date().toISOString() };
  job = current;
  findPeople(getDb(), roleId, (message) => (current.message = message))
    .then((result) => {
      current.state = "done";
      current.result = result;
      current.message = result.people.length > 0 ? `Found ${result.people.length} people` : "No one at the company turned up";
    })
    .catch((err: unknown) => {
      if (err instanceof LinkedInStop) {
        current.state = "stopped";
        current.message = err.message;
        if (err.reason === "checkpoint" || err.reason === "restricted") blocked = err.message;
      } else if (err instanceof ProviderError) {
        current.state = "error";
        current.message = err.status === 429 ? "The model is rate limiting — try again in a minute." : `Model error: ${err.message}`;
      } else {
        current.state = "error";
        current.message = err instanceof Error ? err.message : String(err);
      }
      console.error("[api/contacts]", err);
    });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!isLoopback(req)) return send(res, 403, { error: "Find people only runs from this machine" });
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/status") {
    return send(res, 200, { local: true, counts: cachedCounts(), job, blocked });
  }

  if (url.pathname === "/find") {
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }
    const roleId = typeof body.role === "number" ? body.role : Number(body.role);
    if (!Number.isInteger(roleId) || roleId <= 0) return send(res, 400, { error: "Missing role" });
    if (blocked) return send(res, 423, { error: "blocked", message: blocked, job });
    if (job?.state === "running") {
      return send(res, 409, { error: "busy", message: "Already finding people for another role — one at a time.", job });
    }
    start(roleId);
    return send(res, 202, { job });
  }

  if (url.pathname === "/" || url.pathname === "") {
    const roleId = Number(url.searchParams.get("role"));
    if (!Number.isInteger(roleId) || roleId <= 0) return send(res, 400, { error: "Missing role" });
    return send(res, 200, { result: cachedContacts(roleId), job: job?.roleId === roleId ? job : null, blocked });
  }

  send(res, 404, { error: "Not found" });
}

export function contactsApi(): Plugin {
  return {
    name: "tolara-contacts-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/contacts", (req, res) => void handle(req, res));
    },
  };
}
