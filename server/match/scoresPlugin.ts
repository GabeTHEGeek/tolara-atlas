/**
 * match/scoresPlugin.ts
 *   GET /api/match/scores        -> { candidate, generatedAt, roles: { id: [score, tier] } }
 *   GET /api/match/scores?role=  -> { score } with the category breakdown for one role
 *
 * Dev server only, and only from this machine: the scores are the owner's
 * resume measured against every role (.local/match-scores.json, written by
 * scripts/match-resume.ts), so like Find people there's no static or
 * preview counterpart. On a build these paths don't exist, which is how the
 * UI knows to show no scores at all.
 *
 * The list is score and tier only -- the full breakdown for ~900 roles is
 * close to a megabyte, and the job board needs two numbers per row.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { readScores } from "./scoresFile.js";

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function handle(req: IncomingMessage, res: ServerResponse) {
  if (!isLoopback(req)) return send(res, 403, { error: "Match scores are only served to this machine" });
  const url = new URL(req.url ?? "", "http://localhost");
  // Read per request: re-running the matcher updates the page on reload
  // without restarting the dev server.
  const file = readScores();

  const role = url.searchParams.get("role");
  if (role) return send(res, 200, { score: file?.roles[role] ?? null });

  const roles: Record<string, [number, string]> = {};
  for (const [id, s] of Object.entries(file?.roles ?? {})) roles[id] = [s.score, s.tier];
  send(res, 200, { candidate: file?.candidate ?? null, generatedAt: file?.generatedAt ?? null, roles });
}

export function scoresApi(): Plugin {
  return {
    name: "tolara-scores-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/match/scores", (req, res) => handle(req, res));
    },
  };
}
