import { stripModelDate } from "./normalize.js";
import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

/** Registry slug + event source (`sdk_gemini`) — the SDK identity. */
const PROVIDER = "gemini";
/** The model *vendor* for pricing/rollups. The Google GenAI SDK's models are
 * priced under `google` server-side (`gemini-* → google`), so `model_provider`
 * is `google`, not the `gemini` SDK slug. */
const VENDOR = "google";

/** Gemini's stable-version suffix (`gemini-1.5-pro-002`) — the Gemini analog of
 * a dated snapshot. Strip it (along with any date) so the model matches the
 * bare pricing-table key and rolls up in breakdowns. Kept local to this adapter
 * so the 3-digit strip can't touch another provider's model id. */
const GEMINI_VERSION_RE = /-\d{3}$/;
function normalizeGeminiModel(model: string): string {
  return stripModelDate(model).replace(GEMINI_VERSION_RE, "");
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

/** Build usage from a `GenerateContentResponse` (or the stream path's synthetic). */
function usageFrom(
  result:
    | { usageMetadata?: GeminiUsage; modelVersion?: string; responseId?: string }
    | null
    | undefined,
  args: unknown[],
): ProviderUsage | null {
  const u = result?.usageMetadata;
  if (!u) return null;
  const input = u.promptTokenCount ?? 0;
  const output = u.candidatesTokenCount ?? 0;
  const cacheRead = u.cachedContentTokenCount;
  const body = args[0] as { model?: string } | undefined;
  // Gemini's promptTokenCount is the TOTAL prompt and already includes the
  // cachedContentTokenCount subset (the cached part of the prompt). Report only
  // the non-cached remainder as input_tokens so the server (which prices
  // input_tokens at the input rate AND cache_read_tokens at the cache-read rate)
  // doesn't bill the cached tokens twice — same rule as OpenAI. Gemini reports
  // thinking tokens separately in thoughtsTokenCount, which we don't fold in.
  const usage: ProviderUsage = {
    model: normalizeGeminiModel(result?.modelVersion ?? body?.model ?? "unknown"),
    model_provider: VENDOR,
    input_tokens: Math.max(0, input - (cacheRead ?? 0)),
    output_tokens: output,
  };
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
  if (result?.responseId) usage.provider_message_id = result.responseId;
  return usage;
}

/** Streaming: each chunk is a response; the final chunk carries cumulative usage. */
function usageFromStream(chunks: unknown[], args: unknown[]): ProviderUsage | null {
  const usageChunk = [...chunks]
    .reverse()
    .find((c) => (c as { usageMetadata?: unknown })?.usageMetadata) as
    | { usageMetadata?: GeminiUsage; modelVersion?: string; responseId?: string }
    | undefined;
  if (!usageChunk) return null;
  const first = chunks[0] as { modelVersion?: string; responseId?: string } | undefined;
  return usageFrom(
    {
      usageMetadata: usageChunk.usageMetadata,
      modelVersion: usageChunk.modelVersion ?? first?.modelVersion,
      responseId: usageChunk.responseId ?? first?.responseId,
    },
    args,
  );
}

const modelInfo = (args: unknown[]) => ({
  model_provider: VENDOR,
  model: normalizeGeminiModel((args[0] as { model?: string } | undefined)?.model ?? "unknown"),
});

const methods: MethodSpec[] = [
  {
    path: "models.generateContent",
    extract: (r, a) => usageFrom(r as never, a),
    modelInfo,
  },
  {
    path: "models.generateContentStream",
    isStream: () => true,
    extract: (r, a) => usageFrom(r as never, a), // never called (always a stream)
    extractStream: usageFromStream,
    modelInfo,
  },
];

export const geminiAdapter: Adapter = {
  name: PROVIDER,
  methods,
};
