/**
 * api/intelligencePlugin.ts
 * GET /api/intelligence?company=<slug>&role=<roleId>
 *
 * Serves the role page's "Load company intelligence" button from inside the
 * Vite dev server (`npm run dev`) and preview server (`npm run preview`), so
 * there's no separate backend to run. It has to live server-side because it
 * writes the SQLite cache. When the site is deployed somewhere static,
 * this same handler is what a serverless function would wrap.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { getDb } from "../db/client.js";
import { loadIntelligence, type CompanyIntelligence } from "../enrichment/intelligence.js";

// One lookup per company+role at a time: a double click, or two tabs,
// shares the in-flight request instead of hitting Wikidata/News twice.
const inFlight = new Map<string, Promise<CompanyIntelligence | null>>();

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const params = new URL(req.url ?? "", "http://localhost").searchParams;
  const company = params.get("company")?.trim();
  const roleParam = params.get("role");
  const roleId = roleParam && /^\d+$/.test(roleParam) ? Number(roleParam) : null;
  if (!company || !/^[a-z0-9-]+$/.test(company)) return send(res, 400, { error: "Missing or invalid company" });

  const key = `${company}:${roleId ?? ""}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = loadIntelligence(getDb(), company, roleId).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    const result = await pending;
    if (!result) return send(res, 404, { error: "Unknown company" });
    send(res, 200, result);
  } catch (err) {
    console.error("[api/intelligence]", err);
    send(res, 500, { error: "Couldn't load company intelligence" });
  }
}

export function intelligenceApi(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse) => void handle(req, res);
  return {
    name: "tolara-intelligence-api",
    configureServer(server) {
      server.middlewares.use("/api/intelligence", middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/intelligence", middleware);
    },
  };
}
