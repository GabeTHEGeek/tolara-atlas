/**
 * agent/providers.ts
 * One client, three interchangeable model providers.
 *
 * Gemini, DeepSeek and OpenAI all expose an OpenAI-shaped
 * POST /chat/completions that accepts `tools` and returns `tool_calls`
 * (Gemini via its compatibility endpoint at /v1beta/openai/). So rather
 * than three SDKs, this is one fetch against a base URL, and swapping
 * provider is an env var -- which is the whole point: start on Gemini's
 * free tier, move to DeepSeek if the free limits bite, move to OpenAI if
 * quality demands it, without touching the agent or the UI.
 *
 * Configure with:
 *   TOLARA_AGENT_PROVIDER=gemini|deepseek|openai   (default: gemini)
 *   GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 *   TOLARA_AGENT_MODEL=<id>                        (optional override)
 *   TOLARA_AGENT_FALLBACK=gemini,openai            (optional; tried in order
 *     when the main provider is out of credit, rejects the key, or keeps
 *     failing after its retries -- each uses its own default model)
 *
 * Note this is the TEXT/tool-calling brain only. The voice transport is a
 * separate, separately swappable concern (see src/voice/) -- today it's the
 * browser's free Web Speech API, and a realtime audio API can replace it
 * without the agent noticing.
 */

export type ProviderName = "gemini" | "deepseek" | "openai" | "opencode" | "openrouter" | "nvidia";

interface ProviderConfig {
  baseUrl: string;
  envKey: string;
  // Cheapest capable tool-calling model on each provider, overridable.
  defaultModel: string;
  label: string;
  /**
   * Sampling and any body fields this provider's model actually wants.
   *
   * This exists because the defaults are NOT universal. Nemotron
   * degenerates at temperature 0.3 -- it answered a tool-calling prompt
   * with "state\n\n7.5.5.5.5.5" instead of a function call -- and needs
   * temperature 1 / top_p 0.95, the values NVIDIA ships in its own sample.
   * One hardcoded temperature across every provider is a bug waiting for
   * whichever model doesn't share your assumptions.
   */
  request?: { temperature?: number; top_p?: number; extra?: Record<string, unknown> };
}

// NVIDIA's published sample for this model, plus thinking off: the agent
// takes several turns per utterance and someone is waiting to hear the
// reply, so ~0.5s per call beats the ~1.8s that reasoning mode costs.
// Reasoning also returns its text in `reasoning_content` and can leave
// `content` empty, which is fine for a tool call and useless for speech.
const NEMOTRON_REQUEST = {
  temperature: 1,
  top_p: 0.95,
  // Capped because it's a spoken reply, not an essay: measured at 2.6s
  // uncapped versus 0.9s at 400 on the same prompt, for answers of the same
  // length. It also stops a model that starts rambling from holding up the
  // conversation.
  extra: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 400 },
};

const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-3.6-flash",
    label: "Gemini (free tier)",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    // V4.1 Flash. NOT "deepseek-chat" -- that alias and "deepseek-reasoner"
    // were discontinued on 2026-07-24 and no longer route.
    defaultModel: "deepseek-flash",
    label: "DeepSeek",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    label: "OpenAI",
  },
  // A gateway rather than a lab: one key reaches GPT, Claude, Gemini,
  // DeepSeek, Qwen and others, so TOLARA_AGENT_MODEL matters more here than
  // anywhere else -- the default below is only a sensible starting point.
  // Its `*-free` model ids are NOT usable from here: the API answers 403
  // "OpenCode's free tier can only be used from within OpenCode".
  opencode: {
    baseUrl: "https://opencode.ai/zen/v1",
    envKey: "OPENCODE_API_KEY",
    defaultModel: "deepseek-v4.1-flash",
    label: "OpenCode Zen",
  },
  // Defaults to Nemotron 3.5 Lightning, which OpenRouter serves at zero
  // cost with tool calling. A 30B MoE with 3B active parameters, built for
  // exactly this shape of work -- short, tool-heavy agent turns -- so the
  // free tier's request cap, not its speed, is the thing to watch.
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "nvidia/nemotron-3.5-lightning:free",
    label: "OpenRouter",
    request: NEMOTRON_REQUEST,
  },
  // NVIDIA's own NIM endpoint. Nemotron 3.5 Lightning is a 30B MoE with 3B
  // active parameters built for agent execution, and it shows: a tool call
  // comes back in about half a second with thinking off.
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    defaultModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "NVIDIA NIM",
    request: NEMOTRON_REQUEST,
  },
};

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  // Provider-specific fields ride along on a tool call (see `passthrough`
  // below), so this is deliberately open rather than a closed shape.
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /**
     * Fields the provider attached to this tool call that have to be sent
     * back verbatim on the next turn. Gemini 3.x puts a `thought_signature`
     * in `extra_content` and rejects the follow-up request with a 400 if
     * it's missing ("Function call is missing a thought_signature"). OpenAI
     * and DeepSeek send nothing here, so replaying it is a no-op for them
     * and the adapter stays provider-agnostic.
     */
    passthrough: Record<string, unknown>;
  }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly provider: string | null = null,
  ) {
    super(message);
  }
}

type ResolvedProvider = { name: ProviderName; config: ProviderConfig; apiKey: string; model: string };

/** The main provider, or with `fallback` one from TOLARA_AGENT_FALLBACK (its own default model, no base-URL override). */
export function resolveProvider(fallback?: ProviderName): ResolvedProvider {
  const name = (fallback ?? process.env.TOLARA_AGENT_PROVIDER ?? "gemini").toLowerCase() as ProviderName;
  const config = PROVIDERS[name];
  if (!config) {
    throw new ProviderError(
      `Unknown TOLARA_AGENT_PROVIDER "${name}" ` +
        `(expected gemini, deepseek, openai, opencode, openrouter or nvidia)`,
      null,
      false,
    );
  }
  const apiKey = process.env[config.envKey];
  if (!apiKey) {
    throw new ProviderError(`${config.label} selected but ${config.envKey} is not set`, null, false);
  }
  return {
    name,
    // A base-URL override lets this point at an AI gateway, a self-hosted
    // OpenAI-compatible server, or a stub during testing, without the
    // provider list having to know about it.
    config: fallback ? config : { ...config, baseUrl: process.env.TOLARA_AGENT_BASE_URL || config.baseUrl },
    apiKey,
    model: fallback ? config.defaultModel : process.env.TOLARA_AGENT_MODEL || config.defaultModel,
  };
}

function fallbackNames(): ProviderName[] {
  const main = (process.env.TOLARA_AGENT_PROVIDER ?? "gemini").toLowerCase();
  return (process.env.TOLARA_AGENT_FALLBACK ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n): n is ProviderName => n in PROVIDERS && n !== main);
}

/**
 * What to tell the person, by cause: an empty account and a rejected key
 * are things only they can fix, so those say what to do; a blip says try
 * again. `err.message` keeps the provider's raw answer for the logs.
 */
export function explainProviderError(err: ProviderError): string {
  const label = err.provider ?? "The model provider";
  if (err.status === 402) {
    return `${label} is out of credit. Top up the account, or add a backup provider with TOLARA_AGENT_FALLBACK in .env.`;
  }
  if (err.status === 401 || err.status === 403) return `${label} rejected the API key -- check it in .env.`;
  if (err.status === 429) return `${label} is rate limiting -- try again in a minute.`;
  if (err.status == null && /not set|Unknown TOLARA_AGENT_PROVIDER/.test(err.message)) return err.message;
  return `${label} didn't answer (${err.status ?? "no response"}) -- try again.`;
}

/** The provider in use, for the UI to show without exposing the key. */
export function describeProvider(): {
  provider: string;
  model: string;
  ready: boolean;
  detail: string;
  realtime: boolean;
} {
  // Realtime is a separate switch from the text provider: it replaces the
  // whole audio path, not the model behind /api/agent.
  const realtime =
    (process.env.TOLARA_VOICE_TRANSPORT ?? "webspeech").toLowerCase() === "realtime" &&
    Boolean(process.env.OPENAI_API_KEY);
  try {
    const { name, model } = resolveProvider();
    return {
      provider: realtime ? "openai-realtime" : name,
      model: realtime ? process.env.TOLARA_REALTIME_MODEL || "gpt-realtime-2.1-mini" : model,
      ready: true,
      detail: realtime
        ? `OpenAI Realtime · ${process.env.TOLARA_REALTIME_MODEL || "gpt-realtime-2.1-mini"}`
        : `${PROVIDERS[name].label} · ${model}`,
      realtime,
    };
  } catch (err) {
    return {
      provider: process.env.TOLARA_AGENT_PROVIDER ?? "gemini",
      model: "",
      ready: false,
      detail: err instanceof Error ? err.message : String(err),
      realtime,
    };
  }
}

// Deliberately short. Nemotron answers in under three seconds even with a
// full job description in context, so a call still running at twenty is
// hung, not slow -- and NVIDIA's endpoint does occasionally hang. Failing
// fast and retrying beat one 47-second turn observed with a 30s limit.
const REQUEST_TIMEOUT_MS = 20_000;
// Free tiers rate-limit (429) and shed load (503) routinely -- Gemini
// answers "this model is currently experiencing high demand" often enough
// that a single attempt makes the agent feel broken when it isn't. Someone
// is waiting for a spoken reply, so the backoff is short and shallow.
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `timeoutMs` is for callers nobody is waiting on mid-sentence: a batch
 * job writing a few thousand tokens of JSON (Find people's ranking takes
 * 20-40s on DeepSeek) would otherwise time out on every attempt.
 */
export async function chat(
  messages: ChatMessage[],
  tools: ToolSchema[],
  options: { timeoutMs?: number } = {},
): Promise<ChatResult> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let firstError: ProviderError | null = null;
  for (const fallback of [undefined, ...fallbackNames()]) {
    try {
      return await withRetries(() => chatOnce(resolveProvider(fallback), messages, tools, timeoutMs));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // The first failure is the one to report: it's the provider the
      // person chose, and the fallbacks are a bonus.
      firstError ??= err;
      if (fallback === undefined && fallbackNames().length > 0) {
        console.warn(`[agent] ${err.message} -- trying ${fallbackNames().join(", ")}`);
      }
    }
  }
  throw firstError ?? new ProviderError("Request failed", null, true);
}

async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(BACKOFF_MS[attempt] ?? 1200);
    }
  }
}

async function chatOnce(
  { config, apiKey, model }: ResolvedProvider,
  messages: ChatMessage[],
  tools: ToolSchema[],
  timeoutMs: number,
): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        // Omitted entirely when empty rather than sent as []: the final
        // turn deliberately offers no tools, and an empty array is a
        // different request from no array at all on some providers.
        ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
        // Low but not zero by default: decisive about which tool to call,
        // still human when it talks. Providers whose models want something
        // else say so in their config.
        temperature: config.request?.temperature ?? 0.3,
        ...(config.request?.top_p != null ? { top_p: config.request.top_p } : {}),
        ...(config.request?.extra ?? {}),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      // 429 is the one everyone hits on a free tier; the UI says "slow down"
      // rather than "something went wrong".
      // 402 (no credit) and 403 (model not available to this key) are
      // settled facts about the account, not blips -- retrying just delays
      // the error the user needs to see.
      const retryable = (resp.status === 429 || resp.status >= 500) && resp.status !== 402;
      throw new ProviderError(`${config.label} returned ${resp.status}: ${body.slice(0, 300)}`, resp.status, retryable, config.label);
    }

    const json = (await resp.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } } & Record<string, unknown>>;
        };
      }>;
    };
    // Logged because this can be a paid API and a voice turn makes several
    // calls: spend that isn't visible is spend nobody checks. Cache hits are
    // called out separately since DeepSeek discounts them heavily.
    const usage = json.usage;
    if (usage) {
      const cached = usage.prompt_cache_hit_tokens ?? 0;
      console.log(
        `[agent] ${model} in=${usage.prompt_tokens ?? 0}${cached ? ` (${cached} cached)` : ""} out=${usage.completion_tokens ?? 0}`,
      );
    }

    const message = json.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call, i) => {
      const name = call.function?.name;
      if (!name) return [];
      let args: Record<string, unknown> = {};
      try {
        args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        // A model occasionally emits malformed JSON args. Treat it as a call
        // with no arguments rather than failing the whole turn.
        args = {};
      }
      // Everything that isn't the standard id/type/function trio is the
      // provider's own, and goes back untouched on the next turn.
      const { id: _id, type: _type, function: _fn, ...passthrough } = call as Record<string, unknown>;
      return [{ id: call.id ?? `call_${i}`, name, arguments: args, passthrough }];
    });

    return { content: message?.content ?? null, toolCalls };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError(`${config.label} timed out after ${timeoutMs / 1000}s`, null, true, config.label);
    }
    throw new ProviderError(err instanceof Error ? err.message : String(err), null, true, config.label);
  } finally {
    clearTimeout(timer);
  }
}
