import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Map a Bedrock model id to a canonical `{ provider, model }` so it prices on
 * OBERHAHN's existing table. Strips the optional region prefix (`us.`, `eu.`,
 * `apac.`, `us-gov.`) and the trailing version/date suffixes.
 *
 *   "us.anthropic.claude-3-5-sonnet-20240620-v1:0"
 *     → { provider: "anthropic", model: "claude-3-5-sonnet" }
 */
export function mapBedrockModel(modelId: string): { provider: string; model: string } {
  const withoutRegion = modelId.replace(/^(us|eu|apac|us-gov)\./, "");
  const dot = withoutRegion.indexOf(".");
  const provider = dot >= 0 ? withoutRegion.slice(0, dot) : "bedrock";
  let model = dot >= 0 ? withoutRegion.slice(dot + 1) : withoutRegion;
  model = model.replace(/-v\d+:\d+$/, "").replace(/:\d+$/, "").replace(/-\d{8}$/, "");
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
  },
];

export const bedrockAdapter: Adapter = {
  name: "bedrock",
  methods,
};
