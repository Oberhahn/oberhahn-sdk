/**
 * The adapter contract — the SDK's single extension point.
 *
 * Adding a provider is one file: implement `Adapter`, register it in
 * `registry.ts` under its provider slug. The caller selects it explicitly via
 * `wrap(client, "<name>")`, so there is no structural detection to maintain —
 * the `methods` list alone drives which functions get monkey-patched.
 *
 * Design rule (see the spec): an adapter only *extracts* `{ model,
 * model_provider, tokens, ids }`. It never prices anything — the OBERHAHN
 * server derives cost from the token counts when no provider-reported cost is
 * available. If the provider exposes a real reported cost, an adapter sets
 * `cost` to that value.
 */

/** Canonical usage an adapter pulls out of a provider result. */
export interface ProviderUsage {
  /** Provider model id, e.g. "gpt-4o", "claude-3-5-sonnet". */
  model: string;
  /** Canonical provider slug, e.g. "openai" | "anthropic". */
  model_provider: string;
  input_tokens: number;
  output_tokens: number;
  /** Cache-creation tokens, when the provider reports the split. */
  cache_write_tokens?: number;
  /** Cache-read tokens, when the provider reports the split. */
  cache_read_tokens?: number;
  /** Provider's own message/response id, when present. */
  provider_message_id?: string;
  /** Provider-reported cost, when available and the adapter can read it. */
  cost?: number;
  /**
   * Adapter-derived custom tags, folded into the event `custom` map. Use this
   * for facts about the *call* that aren't the model vendor — most importantly
   * `{ provider: "openrouter" }` / `{ provider: "azure_openai" }` for a
   * routing/hosting layer, so `model_provider` stays the real model vendor (for
   * pricing) while `custom.provider` records who routed/billed it. User
   * `obMetadata` custom keys win over these on a collision.
   */
  custom?: Record<string, string>;
}

export interface MethodSpec {
  /** Dotted method path on the client, e.g. "chat.completions.create". */
  path: string;
  /** Given the (obMetadata-stripped) call args, is this a streaming call? */
  isStream?: (args: unknown[]) => boolean;
  /** Pull usage from a resolved non-stream result. `null` → don't emit. */
  extract(result: unknown, args: unknown[]): ProviderUsage | null;
  /**
   * Pull usage from the collected chunks of a streamed call. `null` → don't
   * emit. Only invoked when `isStream(args)` is true; required for any method
   * that can stream.
   */
  extractStream?(chunks: unknown[], args: unknown[]): ProviderUsage | null;
  /**
   * Resolve `{ model_provider, model }` from the call args alone (no result),
   * for emitting an *error* event when the provider call throws. Return `null`
   * to skip emitting for this call (e.g. a non-usage-bearing command). When
   * omitted, defaults to `{ model_provider: <adapter>, model: args[0].model }`.
   */
  modelInfo?(args: unknown[]): { model_provider: string; model: string } | null;
}

export interface Adapter {
  /** Canonical provider slug, also used in the event `source` (`sdk_<name>`). */
  name: string;
  methods: MethodSpec[];
}
