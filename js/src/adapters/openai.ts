import { stripModelDate } from "./normalize.js";
import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

const PROVIDER = "openai";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  /** OpenAI-compatible gateways (e.g. OpenRouter) report a real cost here. */
  cost?: number;
}

/** Build usage from any object that carries a `usage` block + model + id. */
function usageFrom(
  result: { usage?: OpenAIUsage; model?: string; id?: string } | null | undefined,
  args: unknown[],
): ProviderUsage | null {
  const u = result?.usage;
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens;
  const body = args[0] as { model?: string } | undefined;
  // OpenAI's `prompt_tokens`/`input_tokens` is the TOTAL prompt and already
  // includes the `*_tokens_details.cached_tokens` subset. Report only the
  // non-cached remainder as `input_tokens` so the server (which prices
  // `input_tokens` at the input rate AND `cache_read_tokens` at the cache-read
  // rate — see deriveCost) doesn't bill the cached tokens twice. Mirrors
  // gateway.ts `extractOpenAiUsage` / adapters.ts `billedInput`. (Anthropic's
  // input_tokens is cache-exclusive, so its adapter needs no subtraction.)
  const usage: ProviderUsage = {
    model: stripModelDate(result?.model ?? body?.model ?? "unknown"),
    model_provider: PROVIDER,
    input_tokens: Math.max(0, input - (cacheRead ?? 0)),
    output_tokens: output,
  };
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
  // OpenAI-compatible gateways (e.g. OpenRouter) can report a real cost in the
  // usage block; forward it when present so the server uses it instead of
  // deriving from tokens. Plain OpenAI omits it → stays undefined.
  if (u.cost !== undefined) usage.cost = u.cost;
  if (result?.id) usage.provider_message_id = result.id;
  return usage;
}

/** Streaming: the final chunk carries `usage` when `include_usage` is set. */
function usageFromStream(chunks: unknown[], args: unknown[]): ProviderUsage | null {
  const usageChunk = [...chunks]
    .reverse()
    .find((c) => (c as { usage?: unknown })?.usage) as
    | { usage?: OpenAIUsage; model?: string }
    | undefined;
  if (!usageChunk) return null;
  const first = chunks[0] as { model?: string; id?: string } | undefined;
  return usageFrom(
    { usage: usageChunk.usage, model: usageChunk.model ?? first?.model, id: first?.id },
    args,
  );
}

const isStream = (args: unknown[]): boolean =>
  (args[0] as { stream?: boolean } | undefined)?.stream === true;

const methods: MethodSpec[] = [
  {
    path: "chat.completions.create",
    isStream,
    extract: (r, a) => usageFrom(r as never, a),
    extractStream: usageFromStream,
  },
  {
    path: "responses.create",
    isStream,
    extract: (r, a) => usageFrom(r as never, a),
    extractStream: usageFromStream,
  },
  {
    path: "embeddings.create",
    extract: (r, a) => usageFrom(r as never, a),
  },
];

export const openaiAdapter: Adapter = {
  name: PROVIDER,
  methods,
};
