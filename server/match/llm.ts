/**
 * match/llm.ts
 * One JSON-returning model call, on whatever provider the copilot uses
 * (agent/providers.ts). The provider layer has no JSON mode, so the prompt
 * asks for JSON and this parses it defensively: a fenced block or prose
 * around the object is tolerated, a missing object is a thrown error.
 */

import { chat } from "../agent/providers.js";

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model response");
  return JSON.parse(body.slice(start, end + 1));
}

export async function jsonCall(system: string, user: string): Promise<unknown> {
  const result = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    [],
  );
  return extractJson(result.content ?? "");
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
