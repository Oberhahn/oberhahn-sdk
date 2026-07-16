import type { Provider } from "./registry.js";

/**
 * Best-effort provider detection so `wrap(client)` can be called without naming
 * the provider. We duck-type on the API surface each adapter patches (rather
 * than class names, which minifiers mangle). If nothing matches we throw, asking
 * the caller to pass `{ provider }` — detection never returns a wrong guess.
 *
 * OpenAI-compatible clients (Azure, OpenRouter-via-`openai`, gateways) all share
 * the OpenAI surface, so they resolve to `"openai"`; pass `{ provider }` to
 * select a different adapter for those.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isFn(v: unknown): boolean {
  return typeof v === "function";
}

function isAnthropic(c: Record<string, unknown>): boolean {
  return isRecord(c.messages) && isFn(c.messages.create);
}

function isGemini(c: Record<string, unknown>): boolean {
  return isRecord(c.models) && isFn((c.models as Record<string, unknown>).generateContent);
}

function isOpenAI(c: Record<string, unknown>): boolean {
  const chat = isRecord(c.chat) ? c.chat : {};
  const completions = isRecord(chat.completions) ? chat.completions : {};
  return (
    isFn(completions.create) ||
    isFn(isRecord(c.responses) ? c.responses.create : undefined) ||
    isFn(isRecord(c.embeddings) ? c.embeddings.create : undefined)
  );
}

function isBedrock(c: Record<string, unknown>): boolean {
  // AWS SDK v3 client: send() plus the middlewareStack marker (send alone is
  // too generic to key on).
  return isFn(c.send) && isRecord(c.middlewareStack);
}

export function detectProvider(client: object): Provider {
  const c = client as Record<string, unknown>;
  if (isAnthropic(c)) return "anthropic";
  if (isGemini(c)) return "gemini";
  if (isOpenAI(c)) return "openai";
  if (isBedrock(c)) return "bedrock";
  throw new Error(
    `[oberhahn] wrap(): couldn't detect the provider from this client. ` +
      `Pass it explicitly, e.g. wrap(client, { provider: "openai" }).`,
  );
}
