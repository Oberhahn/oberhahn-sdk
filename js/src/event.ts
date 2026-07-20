import type { ProviderUsage } from "./adapters/types.js";
import type { RoutedMetadata } from "./metadata.js";

/**
 * The canonical payload POSTed to `POST {baseUrl}/events`. Intentionally a
 * loose input shape: the OBERHAHN server fills `organization_id`,
 * `consumer_id`, `date`, and derives `cost` from the token counts. The SDK
 * never prices anything.
 */
export interface OberhahnEvent {
  source: string;
  consumer_type: string;
  consumer_id?: string;
  task_id?: string;
  provider_session_id?: string;
  provider_message_id?: string;
  spend_details: {
    model_provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    /** Canonical TOTAL of cache read + write. */
    cached_tokens: number;
    cache_write_tokens?: number;
    cache_read_tokens?: number;
    /** Provider-reported cost, when present. */
    cost?: number;
  };
  /** `"success"` for a completed call, `"error"` when the provider call threw. */
  status: string;
  /** Wall-clock duration of the provider call, in milliseconds. */
  duration_ms?: number;
  /** Provider-reported cost, top-level (the field the server reads on ingest).
   * Mirrors `spend_details.cost`. */
  cost?: number;
  custom?: Record<string, string>;
}

const DEFAULT_CONSUMER_TYPE = "customer";

/**
 * A single, provider-independent `source` for every SDK-emitted event. 
 */
const EVENT_SOURCE = "sdk_oberhahn";

export function buildEvent(
  usage: ProviderUsage,
  routed: RoutedMetadata,
  opts: { durationMs?: number; status?: string } = {},
): OberhahnEvent {
  const cacheWrite = usage.cache_write_tokens;
  const cacheRead = usage.cache_read_tokens;
  const hasSplit = cacheWrite !== undefined || cacheRead !== undefined;
  // When the split is known the server prices it and ignores `cached_tokens`;
  // set the total to the sum so a total-only consumer still sees it.
  const cached_tokens = hasSplit ? (cacheWrite ?? 0) + (cacheRead ?? 0) : 0;

  const spend_details: OberhahnEvent["spend_details"] = {
    model_provider: usage.model_provider,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens,
  };
  if (cacheWrite !== undefined) spend_details.cache_write_tokens = cacheWrite;
  if (cacheRead !== undefined) spend_details.cache_read_tokens = cacheRead;
  if (usage.cost !== undefined) spend_details.cost = usage.cost;

  const event: OberhahnEvent = {
    source: EVENT_SOURCE,
    consumer_type: routed.consumer_type ?? DEFAULT_CONSUMER_TYPE,
    spend_details,
    status: opts.status ?? "success",
  };
  if (opts.durationMs !== undefined) event.duration_ms = opts.durationMs;
  if (routed.consumer_id) event.consumer_id = routed.consumer_id;
  if (routed.task_id) event.task_id = routed.task_id;
  if (routed.provider_session_id) event.provider_session_id = routed.provider_session_id;
  if (usage.provider_message_id) event.provider_message_id = usage.provider_message_id;
  // Provider-reported cost also goes top-level: the server reads the reported
  // cost from `event.cost` (see oberhahn-loop normalize.ts), so a nested
  // `spend_details.cost` alone would be ignored and the model re-priced
  // (yielding cost_unknown for unpriceable ids like OpenRouter's).
  if (usage.cost !== undefined) event.cost = usage.cost;
  // Adapter-derived custom tags (e.g. `provider: "openrouter"`) sit *under*
  // user `obMetadata` custom, so an explicit caller value always wins.
  const custom = { ...usage.custom, ...routed.custom };
  if (Object.keys(custom).length > 0) event.custom = custom;
  return event;
}
