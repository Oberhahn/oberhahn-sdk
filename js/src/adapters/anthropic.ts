import { stripModelDate } from "./normalize.js";
import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

const PROVIDER = "anthropic";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function fromMessage(
  msg: { usage?: AnthropicUsage; model?: string; id?: string } | null | undefined,
  args: unknown[],
): ProviderUsage | null {
  const u = msg?.usage;
  if (!u) return null;
  const body = args[0] as { model?: string } | undefined;
  const usage: ProviderUsage = {
    model: stripModelDate(msg?.model ?? body?.model ?? "unknown"),
    model_provider: PROVIDER,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };
  // Real SDK reports these as `number | null` — only carry a real count.
  if (typeof u.cache_creation_input_tokens === "number")
    usage.cache_write_tokens = u.cache_creation_input_tokens;
  if (typeof u.cache_read_input_tokens === "number")
    usage.cache_read_tokens = u.cache_read_input_tokens;
  if (msg?.id) usage.provider_message_id = msg.id;
  return usage;
}

/**
 * Streaming usage is split across events: `message_start` carries input +
 * cache tokens, `message_delta` carries the running output total.
 */
function fromStream(chunks: unknown[], args: unknown[]): ProviderUsage | null {
  let id: string | undefined;
  let model: string | undefined;
  const merged: AnthropicUsage = {};
  for (const raw of chunks) {
    const ev = raw as {
      type?: string;
      message?: { id?: string; model?: string; usage?: AnthropicUsage };
      usage?: AnthropicUsage;
    };
    if (ev?.type === "message_start" && ev.message) {
      id = ev.message.id;
      model = ev.message.model;
      const u = ev.message.usage ?? {};
      merged.input_tokens = u.input_tokens ?? merged.input_tokens;
      merged.cache_creation_input_tokens =
        u.cache_creation_input_tokens ?? merged.cache_creation_input_tokens;
      merged.cache_read_input_tokens =
        u.cache_read_input_tokens ?? merged.cache_read_input_tokens;
    } else if (ev?.type === "message_delta" && ev.usage) {
      merged.output_tokens = ev.usage.output_tokens ?? merged.output_tokens;
    }
  }
  if (id === undefined && model === undefined && Object.keys(merged).length === 0) return null;
  return fromMessage({ usage: merged, model, id }, args);
}

const methods: MethodSpec[] = [
  {
    path: "messages.create",
    isStream: (args) => (args[0] as { stream?: boolean } | undefined)?.stream === true,
    extract: (r, a) => fromMessage(r as never, a),
    extractStream: fromStream,
  },
];

export const anthropicAdapter: Adapter = {
  name: PROVIDER,
  methods,
};
