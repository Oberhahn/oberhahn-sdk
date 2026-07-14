import { OberhahnClient } from "./client.js";
import { resolveConfig, type OberhahnConfig } from "./config.js";
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
 * Wrap a provider client for the named `provider` (`"openai"` | `"anthropic"` |
 * `"bedrock"`): look the adapter up in the registry matrix, monkey-patch the
 * usage-bearing methods it declares, and return the same client (mutated in
 * place, typed as itself). Idempotent. Throws on an unknown provider slug; warns
 * (and no-ops) if the client carries none of that provider's methods.
 */
export function wrap<T extends object>(client: T, provider: string, opts: WrapOptions = {}): T {
  const adapter = adapterFor(provider);
  if (!adapter) {
    throw new Error(
      `[oberhahn] wrap(): unknown provider "${provider}". Known providers: ${knownProviders().join(", ")}.`,
    );
  }
  return patchClient(client, adapter, ensureClient(), opts);
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
export type { OberhahnEvent } from "./event.js";
export type { Adapter, MethodSpec, ProviderUsage } from "./adapters/types.js";
export { OberhahnClient } from "./client.js";
