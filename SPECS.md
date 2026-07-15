# SDK Adapter Contract

What an adapter must produce. This is the **SDK-owned** contract; it is the
source an agent reads when adding a provider (see `.claude/commands/add-provider.md`).

> The **event / ingest contract** (`POST /events`, `spend_details`, cost
> derivation, field aliases, normalization) is **not** defined here — it's owned
> by the OBERHAHN Core API and its canonical, auto-generated spec:
> `PinataCloud/oberhahn-loop/SPECS.md`. Don't restate it here; reference it.

## What the SDK does

Wrap a provider client in place; for each usage-bearing call, extract token usage
and POST it to OBERHAHN. The SDK is **thin**: never prices anything, never sends
prompt/response content, never blocks or breaks the wrapped call. The server
fills `organization_id` / `date` / `cost` from the `oak_` key + token counts.

## The adapter (one file per provider)

- **`ProviderUsage`** — `{ model, model_provider, input_tokens, output_tokens,
  cache_write_tokens?, cache_read_tokens?, provider_message_id?, cost? }`.
- **`MethodSpec`** per usage-bearing method:
  - `path` — dotted method to monkey-patch (e.g. `chat.completions.create`).
  - `extract(result, args|kwargs) -> ProviderUsage | null` — non-stream usage.
  - `is_stream(args|kwargs) -> bool` — is this call streaming?
  - `extract_stream(chunks, args|kwargs) -> ProviderUsage | null` — usage from the
    collected chunks (required for any method that can stream).
  - `model_info(args|kwargs) -> (provider, model) | null` — resolve provider +
    model from the request alone, for `status:"error"` events (defaults to
    `(<adapter>, model-from-request)`; `null` = non-billable call, skip).
- **`Adapter`** — `{ name, methods }`; register under `name` in the registry.

## Token rules

- Report `input_tokens` as **non-cached** prompt tokens. If a provider's input
  count *includes* cached tokens (OpenAI `prompt_tokens`), subtract the cached
  portion. If it's cache-*exclusive* (Anthropic `input_tokens`), don't.
- Emit `cache_write_tokens` / `cache_read_tokens` **only when the provider
  reports them** (omit — never 0/null — when absent).

## Rules

Never compute cost. Never send request/response bodies. Touch only the adapter +
registry + dep + test + drift canary — never the core wrapper, event builder,
client, or metadata routing.

## Current provider mappings

| Provider | Methods | Model | Cache |
| --- | --- | --- | --- |
| openai | `chat.completions.create`, `responses.create`, `embeddings.create` | `result.model` / request `model` | `prompt_tokens` includes cached → subtract; `prompt_tokens_details.cached_tokens` → read |
| anthropic | `messages.create` | `msg.model` / request `model` | `input_tokens` cache-exclusive; `cache_creation_input_tokens`→write, `cache_read_input_tokens`→read |
| bedrock | `converse`, `converse_stream` (py) / `send(ConverseCommand)` (js) | mapped from `modelId` | `cacheWriteInputTokens` / `cacheReadInputTokens` |
| gemini | `models.generate_content(_stream)` (py) / `models.generateContent(Stream)` (js) | `usage_metadata`/`usageMetadata`; model from `model_version` else request; id from `response_id` | `prompt_token_count` includes cached → subtract; `cached_content_token_count` → read (no write count) |
