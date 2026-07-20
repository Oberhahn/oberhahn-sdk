import type { Adapter } from "./adapters/types.js";

/**
 * OpenAI-wire-compatible providers: their clients ARE the OpenAI SDK pointed at
 * a different `baseURL`, so they use the OpenAI adapter to read usage. Passing
 * one of these as `provider` tags the event with `custom.provider="<slug>"` (the
 * routing layer) while `model_provider` stays what the adapter reports — exactly
 * like Bedrock records its hosting layer. Auto-detection can't tell them apart
 * from OpenAI, so they must be named explicitly:
 * `wrap(client, { provider: "openrouter" })`.
 */
export const OPENAI_COMPATIBLE_PROVIDERS = [
  "openrouter",
  "together",
  "fireworks",
  "groq",
  "deepinfra",
  "perplexity",
  "xai",
  "deepseek",
  "mistral",
  "azure",
] as const;

/**
 * The provider slugs `wrap()` accepts. Native adapters are auto-detectable; the
 * OpenAI-compatible slugs must be passed explicitly. Add a new literal here when
 * you register an adapter, so callers get autocomplete + a compile error on typos.
 */
export type Provider =
  | "openai"
  | "anthropic"
  | "bedrock"
  | "gemini"
  | (typeof OPENAI_COMPATIBLE_PROVIDERS)[number];
import { anthropicAdapter } from "./adapters/anthropic.js";
import { bedrockAdapter } from "./adapters/bedrock.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { openaiAdapter } from "./adapters/openai.js";
// scaffold:imports  (scripts/new-adapter.mjs inserts new adapter imports above this line)

/**
 * The provider matrix: slug → adapter. The caller names the provider on
 * `wrap(client, { provider: "<slug>" })`; we look the adapter up here and patch the methods
 * it declares. No structural detection, no ordering, no ambiguity.
 */
export const ADAPTERS: Record<string, Adapter> = {
  [openaiAdapter.name]: openaiAdapter,
  [anthropicAdapter.name]: anthropicAdapter,
  [bedrockAdapter.name]: bedrockAdapter,
  [geminiAdapter.name]: geminiAdapter,
  // scaffold:entries  (scripts/new-adapter.mjs inserts new adapter entries above this line)
};

/** Adapter for a provider slug, or `undefined` if the slug is unknown.
 * OpenAI-compatible slugs resolve to the OpenAI adapter. */
export function adapterFor(provider: string): Adapter | undefined {
  if (ADAPTERS[provider]) return ADAPTERS[provider];
  if ((OPENAI_COMPATIBLE_PROVIDERS as readonly string[]).includes(provider)) return openaiAdapter;
  return undefined;
}

/** Known provider slugs, for error messages and discovery. */
export function knownProviders(): string[] {
  return [...Object.keys(ADAPTERS), ...OPENAI_COMPATIBLE_PROVIDERS];
}

export { openaiAdapter, anthropicAdapter, bedrockAdapter, geminiAdapter };
