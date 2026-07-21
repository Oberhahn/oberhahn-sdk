/**
 * Merge global + per-call attribution and route each key: known keys map to
 * canonical top-level event fields; everything else lands in `custom` (coerced
 * to strings, since OBERHAHN's `custom` is a string→string map).
 */

export interface RoutedMetadata {
  provider_session_id?: string;
  task_id?: string;
  consumer_id?: string;
  consumer_type?: string;
  custom: Record<string, string>;
}

/** Per-call/global key → canonical event field. Aliases mirror the server. */
const KNOWN: Record<string, keyof Omit<RoutedMetadata, "custom">> = {
  session_id: "provider_session_id",
  provider_session_id: "provider_session_id",
  task_id: "task_id",
  consumer_id: "consumer_id",
  consumer_type: "consumer_type",
};

function toStr(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Merge sources in ascending precedence (later wins), then route.
 * Typical order: [init.metadata, wrap.metadata, obMetadata].
 */
export function routeMetadata(...sources: Array<Record<string, unknown> | undefined>): RoutedMetadata {
  const merged: Record<string, unknown> = {};
  for (const src of sources) {
    if (src) Object.assign(merged, src);
  }

  const routed: RoutedMetadata = { custom: {} };
  for (const [key, value] of Object.entries(merged)) {
    if (value == null) continue;
    const known = KNOWN[key];
    if (known) {
      const s = toStr(value);
      if (s !== undefined) routed[known] = s;
    } else {
      const s = toStr(value);
      if (s !== undefined) routed.custom[key] = s;
    }
  }
  return routed;
}
