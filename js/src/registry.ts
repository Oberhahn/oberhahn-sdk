import type { Adapter } from "./adapters/types.js";
import { anthropicAdapter } from "./adapters/anthropic.js";
import { bedrockAdapter } from "./adapters/bedrock.js";
import { openaiAdapter } from "./adapters/openai.js";

/**
 * The provider matrix: slug → adapter. The caller names the provider on
 * `wrap(client, "<slug>")`; we look the adapter up here and patch the methods
 * it declares. No structural detection, no ordering, no ambiguity.
 */
export const ADAPTERS: Record<string, Adapter> = {
  [openaiAdapter.name]: openaiAdapter,
  [anthropicAdapter.name]: anthropicAdapter,
  [bedrockAdapter.name]: bedrockAdapter,
};

/** Adapter for a provider slug, or `undefined` if the slug is unknown. */
export function adapterFor(provider: string): Adapter | undefined {
  return ADAPTERS[provider];
}

/** Known provider slugs, for error messages and discovery. */
export function knownProviders(): string[] {
  return Object.keys(ADAPTERS);
}

export { openaiAdapter, anthropicAdapter, bedrockAdapter };
