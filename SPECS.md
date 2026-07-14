# OBERHAHN SDK — Specification

The canonical contract both SDKs (`js/`, `python/`) implement, and the source of
truth an agent reads when adding a provider (see `.claude/commands/add-provider.md`).

## 1. What the SDK does

Wrap a provider client in place; for each usage-bearing call, extract token usage
+ attribution and POST a canonical event to OBERHAHN. The SDK is **thin**: it
never prices anything, never sends prompt/response content, and never blocks or
breaks the wrapped call.

## 2. The canonical event (`POST {baseUrl}/events`)

The SDK sends a **subset**; the server fills the rest.

| Field | Who sets it | Notes |
| --- | --- | --- |
| `source` | SDK | `sdk_<provider>` (e.g. `sdk_openai`) |
| `consumer_type` | SDK | from metadata; default `customer` |
| `consumer_id` | SDK (if present) | from metadata |
| `task_id` | SDK (if present) | from metadata |
| `provider_session_id` | SDK (if present) | from `session_id` metadata |
| `provider_message_id` | SDK (if present) | provider's response id |
| `spend_details` | SDK | see below |
| `status` | SDK | `"success"` or `"error"` |
| `duration_ms` | SDK | wall-clock of the provider call |
| `custom` | SDK (if non-empty) | string→string map |
| `organization_id`, `date`, `cost` | **server** | derived from the `oak_` key + token counts — SDK never sends these |

`spend_details`:

```
{ model_provider, model, input_tokens, output_tokens,
  cached_tokens,                 // canonical TOTAL of cache read + write
  cache_write_tokens?,           // only when the provider reports the split
  cache_read_tokens? }
```

**Token rules (get these right per provider):**
- Report `input_tokens` as the **non-cached** prompt tokens. If a provider's
  input count *includes* cached tokens (OpenAI `prompt_tokens`/`input_tokens`),
  subtract the cached portion so the server doesn't double-bill. If it's
  cache-*exclusive* (Anthropic `input_tokens`), don't subtract.
- Emit `cache_write_tokens` / `cache_read_tokens` **only when the provider
  reports them** (omit, don't send 0/null, when absent).

## 3. The adapter contract (the one extension point)

One file per provider. Implement:

- **`ProviderUsage`** — `{ model, model_provider, input_tokens, output_tokens,
  cache_write_tokens?, cache_read_tokens?, provider_message_id? }`.
- **`MethodSpec`** per usage-bearing method:
  - `path` — dotted method to monkey-patch (e.g. `chat.completions.create`).
  - `extract(result, args|kwargs) -> ProviderUsage | null` — non-stream usage.
  - `is_stream(args|kwargs) -> bool` — is this call streaming?
  - `extract_stream(chunks, args|kwargs) -> ProviderUsage | null` — usage from
    the collected chunks (required for any method that can stream).
  - `model_info(args|kwargs) -> (provider, model) | null` — resolve provider +
    model from the request alone, for `status:"error"` events. Defaults to
    `(<adapter>, model-from-request)`; return `null` to skip (non-billable call).
- **`Adapter`** — `{ name, methods }`; register under `name` in the registry.

**Rules:** never compute cost; never send request/response bodies; touch only the
adapter + registry + dep + test + drift canary — never the core wrapper, event
builder, client, or metadata routing.

## 4. Metadata routing

Merge global (`init`) + per-client (`wrap`) + per-call (`ob_metadata`), later
wins. Known keys → canonical fields; everything else → `custom` (coerced to
strings). Known: `session_id`→`provider_session_id`, `provider_session_id`,
`task_id`, `consumer_id`, `consumer_type`.

## 5. Streaming

The wrapper tees the stream — every chunk passes through to the caller
unchanged — and calls `extract_stream` once, after the last chunk. A mid-stream
failure emits `status:"error"`.

## 6. Current provider mappings (ground truth)

| Provider | Methods | Model field | Cache handling |
| --- | --- | --- | --- |
| openai | `chat.completions.create`, `responses.create`, `embeddings.create` | `result.model` / request `model` | `prompt_tokens` INCLUDES cached → subtract; `prompt_tokens_details.cached_tokens` → `cache_read_tokens` |
| anthropic | `messages.create` | `msg.model` / request `model` | `input_tokens` is cache-exclusive → no subtraction; `cache_creation_input_tokens`→write, `cache_read_input_tokens`→read |
| bedrock | `converse`, `converse_stream` (py) / `send(ConverseCommand)` (js) | mapped from `modelId` (strips region prefix + version/date suffix) | `cacheWriteInputTokens`/`cacheReadInputTokens` |
