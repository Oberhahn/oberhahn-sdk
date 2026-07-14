/** Global + per-client configuration. */
export interface OberhahnConfig {
  /** `oak_` key → org + consumer scope. Env: `OBERHAHN_API_KEY`. */
  apiKey?: string;
  /** API root including `/v0`. Env: `OBERHAHN_BASE_URL`. Defaults to the hosted
   * endpoint (`https://app.oberhahn.com/v0`); set only for self-hosted/staging. */
  baseUrl?: string;
  /** Global attribution merged into every event (lowest precedence). */
  metadata?: Record<string, unknown>;
  /**
   * Attribution failures should never break the request path. Default `false`
   * (swallow + `onError`). When `true`, the submit promise rejects.
   */
  throwOnError?: boolean;
  /** Kill switch. Default `true`. Env `OBERHAHN_SDK_DISABLED` forces off. */
  enabled?: boolean;
  /** Transient-failure retry attempts for a submit. Default `2`. */
  maxRetries?: number;
  /** Injectable fetch (tests / custom transport). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Called with any swallowed submit error (only when `throwOnError` is off). */
  onError?: (err: unknown) => void;
}

export interface ResolvedConfig {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  metadata: Record<string, unknown>;
  throwOnError: boolean;
  enabled: boolean;
  maxRetries: number;
  fetch: typeof fetch;
  onError: ((err: unknown) => void) | undefined;
}

function envDisabled(): boolean {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.OBERHAHN_SDK_DISABLED;
  return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function env(name: string): string | undefined {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return v != null && v !== "" ? v : undefined;
}

/**
 * Hosted OBERHAHN ingest endpoint (incl. the `/v0` suffix). Overridable via the
 * `baseUrl` config or `OBERHAHN_BASE_URL` — set it for self-hosted / staging.
 */
export const DEFAULT_BASE_URL = "https://app.oberhahn.com/v0";

export function resolveConfig(input: OberhahnConfig = {}): ResolvedConfig {
  const enabled = input.enabled === false ? false : !envDisabled();
  return {
    apiKey: input.apiKey ?? env("OBERHAHN_API_KEY"),
    baseUrl: input.baseUrl ?? env("OBERHAHN_BASE_URL") ?? DEFAULT_BASE_URL,
    metadata: input.metadata ?? {},
    throwOnError: input.throwOnError ?? false,
    enabled,
    maxRetries: input.maxRetries ?? 2,
    fetch: input.fetch ?? (globalThis.fetch as typeof fetch),
    onError: input.onError,
  };
}
