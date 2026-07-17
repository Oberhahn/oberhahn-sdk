import { stripModelDate } from "./normalize.js";
import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

/** Bedrock is a hosting layer: `model_provider` is the real model vendor
 * (anthropic/amazon/meta/…), and `custom.provider` records that AWS Bedrock
 * routed/billed the call. */
const HOSTING = "bedrock";

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Map a Bedrock model id to a canonical `{ provider, model }` so it prices on
 * OBERHAHN's existing table.
 *
 * A Bedrock id is `[<geo>.]<vendor>.<name>` — an optional cross-region
 * inference-profile prefix (`us.`, `eu.`, `apac.`, `us-gov.`, `global.`, …),
 * the model vendor (`anthropic`/`amazon`/`meta`/`mistral`/`cohere`/`ai21`/…),
 * then the model name. Model names never contain a `.`, so the segment count
 * tells us whether a geo prefix is present — no geo allowlist to maintain.
 * The trailing version/date suffixes are stripped so the name matches the
 * pricing table.
 *
 *   "us.anthropic.claude-3-5-sonnet-20240620-v1:0"
 *     → { provider: "anthropic", model: "claude-3-5-sonnet" }
 *   "meta.llama3-1-70b-instruct-v1:0"
 *     → { provider: "meta", model: "llama3-1-70b-instruct" }
 */
export function mapBedrockModel(modelId: string): { provider: string; model: string } {
  const parts = modelId.split(".");
  let provider: string;
  let model: string;
  if (parts.length >= 3) {
    // <geo>.<vendor>.<name> — drop the geo prefix, vendor is the real vendor.
    provider = parts[1];
    model = parts.slice(2).join(".");
  } else if (parts.length === 2) {
    // <vendor>.<name>
    provider = parts[0];
    model = parts[1];
  } else {
    // Bare name with no vendor prefix — fall back to the hosting layer.
    provider = HOSTING;
    model = parts[0];
  }
  // Strip Bedrock's hosting revision (`-v2:0` / bare `:0`) first, then the
  // shared dated-snapshot suffix — so `claude-3-5-sonnet-20240620-v1:0` reduces
  // to the bare `claude-3-5-sonnet` the pricing table keys on.
  model = stripModelDate(model.replace(/-v\d+:\d+$/, "").replace(/:\d+$/, ""));
  return { provider, model };
}

function commandName(args: unknown[]): string | undefined {
  return (args[0] as { constructor?: { name?: string } } | undefined)?.constructor?.name;
}

function modelIdFrom(args: unknown[]): string {
  return (args[0] as { input?: { modelId?: string } } | undefined)?.input?.modelId ?? "";
}

function toUsage(u: BedrockUsage | undefined, args: unknown[]): ProviderUsage | null {
  if (!u) return null;
  const { provider, model } = mapBedrockModel(modelIdFrom(args));
  const usage: ProviderUsage = {
    model: model || "unknown",
    model_provider: provider,
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    custom: { provider: HOSTING },
  };
  if (u.cacheWriteInputTokens !== undefined) usage.cache_write_tokens = u.cacheWriteInputTokens;
  if (u.cacheReadInputTokens !== undefined) usage.cache_read_tokens = u.cacheReadInputTokens;
  return usage;
}

const methods: MethodSpec[] = [
  {
    path: "send",
    isStream: (args) => commandName(args) === "ConverseStreamCommand",
    extract: (result, args) => {
      // Only Converse commands carry usage; everything else passes through.
      if (commandName(args) !== "ConverseCommand") return null;
      return toUsage((result as { usage?: BedrockUsage } | undefined)?.usage, args);
    },
    extractStream: (chunks, args) => {
      const metaChunk = chunks.find(
        (c) => (c as { metadata?: { usage?: unknown } })?.metadata?.usage,
      ) as { metadata?: { usage?: BedrockUsage } } | undefined;
      return toUsage(metaChunk?.metadata?.usage, args);
    },
    // For error events: only Converse commands are billable operations; skip
    // anything else (e.g. a failed ListFoundationModels) by returning null.
    modelInfo: (args) => {
      const name = commandName(args);
      if (name !== "ConverseCommand" && name !== "ConverseStreamCommand") return null;
      const { provider, model } = mapBedrockModel(modelIdFrom(args));
      return { model_provider: provider, model: model || "unknown" };
    },
  },
];

export const bedrockAdapter: Adapter = {
  name: "bedrock",
  methods,
};
