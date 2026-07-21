import { OberhahnClient } from "./client.js";
import { resolveConfig, type OberhahnConfig } from "./config.js";
import { detectProvider } from "./detect.js";
import { adapterFor, knownProviders } from "./registry.js";
import { patchClient, type WrapOptions } from "./wrap.js";

let globalClient: OberhahnClient | null = null;

/** Set global config. Safe to call once at process start; may read env. */
export function init(config: OberhahnConfig = {}): OberhahnClient {
  globalClient = new OberhahnClient(resolveConfig(config));
  return globalClient;
}

function ensureClient(): OberhahnClient {
  if (!globalClient) globalClient = new OberhahnClient(resolveConfig());
  return globalClient;
}

/**
 * Wrap a provider client: look its adapter up in the registry matrix,
 * monkey-patch the usage-bearing methods it declares, and return the same client
 * (mutated in place, typed as itself). Idempotent.
 *
 * The provider is resolved in this order:
 *   1. `options.provider`, if given — `wrap(client, { provider: "openrouter" })`.
 *   2. otherwise auto-detected from the client — `wrap(client)`. Detection
 *      throws if the client is ambiguous (pass `{ provider }` in that case).
 *
 * Throws on an unknown/undetectable provider; warns (and no-ops) if the client
 * carries none of that provider's methods.
 */
export function wrap<T extends object>(client: T, options: WrapOptions = {}): T {
  const resolved = options.provider ?? detectProvider(client);
  const adapter = adapterFor(resolved);
  if (!adapter) {
    throw new Error(
      `[oberhahn] wrap(): unknown provider "${resolved}". Known providers: ${knownProviders().join(", ")}.`,
    );
  }
  // When the requested slug isn't the adapter's own name (e.g. an
  // OpenAI-compatible provider routed through the OpenAI adapter), record it as
  // custom.provider so model_provider stays the vendor the adapter reports.
  const providerTag = resolved !== adapter.name ? resolved : undefined;
  return patchClient(client, adapter, ensureClient(), options, providerTag);
}

/**
 * Await every event submitted so far. Submission is fire-and-forget, so this is
 * a no-op a long-lived server never needs. Call it in short-lived / serverless
 * contexts — e.g. at the end of a Lambda handler — to drain before the runtime
 * freezes or reaps the process, so the last events aren't lost. Never rejects.
 */
export async function flush(): Promise<void> {
  if (globalClient) await globalClient.flush();
}

export type { OberhahnConfig } from "./config.js";
export type { WrapOptions } from "./wrap.js";
export type { Provider } from "./registry.js";
export { OPENAI_COMPATIBLE_PROVIDERS, knownProviders } from "./registry.js";
export { detectProvider } from "./detect.js";
export type { OberhahnEvent } from "./event.js";
export type { Adapter, MethodSpec, ProviderUsage } from "./adapters/types.js";
export { OberhahnClient } from "./client.js";
