# `oberhahn` (Python)

A thin, server-side Python SDK that wraps native provider SDKs, extracts token
usage + attribution from each call, and posts canonical events to OBERHAHN's
`POST /v0/events`.

Wrap your existing provider client once and keep calling it exactly as before —
the SDK captures token usage and attribution from each call and reports it to
OBERHAHN in the background. It stays out of the request path: no config to thread
through your call sites, no buffering, and failures never break your calls.

Supports OpenAI, Anthropic, AWS Bedrock, Google Gemini, and more — call
`known_providers()` for the live list (it's the source of truth; new providers
are one-file adapters). Provider SDKs are *optional* — install only what you use.

## Install

```sh
pip install oberhahn                  # core only (no provider SDKs)
pip install "oberhahn[openai]"        # + one extra per provider you use:
                                      #   openai | anthropic | bedrock | gemini | …
```

The core package has **no required dependencies** (standard library only). Each
provider is an optional extra (see `[project.optional-dependencies]` in
`pyproject.toml`).

## Usage

```python
import oberhahn
from openai import OpenAI

oberhahn.init(api_key="oak_...")   # oak_… key → org + consumer scope

# Provider is auto-detected from the client.
client = oberhahn.wrap(
    OpenAI(),
    metadata={"environment": "production", "feature": "support_agent"},
)

client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    ob_metadata={"customer_id": "cust_123", "session_id": session_id, "turn_id": turn_id},
)
```

Works the same for `AsyncOpenAI` / `AsyncAnthropic` — `await` the call as usual.

## API

- **`init(**config)`** — set global config (also read from env). Returns the client.
- **`wrap(client, *, metadata=None)`** — patch the provider's usage-bearing
  methods in place and return the same client. The provider is **auto-detected**
  from the client (`wrap(OpenAI())`).
- **`ob_metadata`** (or `obMetadata`) as a keyword argument on a request →
  per-call attribution; stripped from the kwargs before the provider call is
  forwarded.
- **`flush()`** — block until every event submitted so far has posted. Optional:
  events go out immediately on a background worker thread, and the interpreter
  joins those threads on normal exit, so a long-lived server or plain script
  never needs it. Call it in short-lived / serverless contexts (e.g. at the end
  of a Lambda handler) to drain before the runtime freezes or reaps the process.

Submission is fire-and-forget and best-effort — the wrapped request never waits
on it, and a delivery failure past `max_retries` is dropped (surfaced via
`on_error`), never raised into your call path.

```python
def handler(event, context):
    res = client.chat.completions.create(model=model, messages=messages)
    oberhahn.flush()   # drain before the platform freezes this invocation
    return res
```

### Config

| Argument         | Env                     | Default | Purpose                                                       |
| ---------------- | ----------------------- | ------- | ------------------------------------------------------------- |
| `api_key`        | `OBERHAHN_API_KEY`      | —       | `oak_` key; sent as `Authorization: Bearer`.                  |
| `metadata`       | —                       | `{}`    | Global attribution merged into every event.                   |
| `throw_on_error` | —                       | `False` | Attribution failures must not break the request path.         |
| `enabled`        | `OBERHAHN_SDK_DISABLED` | `True`  | Kill switch (no-op passthrough when off).                     |
| `max_retries`    | —                       | `2`     | Transient-failure retries (exponential backoff).              |
| `transport`      | —                       | urllib  | Injectable transport `(url, headers, body) -> status` (tests).|
| `on_error`       | —                       | —       | Called with any swallowed submit error (when not throwing).   |

### Metadata routing

Global (`init`) + per-client (`wrap`) + per-call (`ob_metadata`) metadata are
merged (later wins). Known keys map to canonical event fields
(`session_id` → `provider_session_id`, plus `task_id`, `consumer_id`,
`consumer_type`); everything else is coerced to strings and placed in `custom`.

> **Bedrock:** the Python SDK uses boto3's Converse API — call
> `client.converse(modelId=..., messages=...)` /
> `client.converse_stream(...)`. Attach per-call attribution with the ordinary
> `ob_metadata=...` keyword argument, just like the other providers.

> **Gemini:** wrap a `google-genai` client and call
> `client.models.generate_content(model=..., contents=...)` /
> `client.models.generate_content_stream(...)`. Attach per-call attribution with
> the ordinary `ob_metadata=...` keyword argument, just like the other providers.

## Extending it

The SDK is designed so **adding a provider is a one-file adapter** — the core
wrapper and event mapping never change. If you want to add a provider or hack on
the SDK, see [CONTRIBUTING.md](./CONTRIBUTING.md) (scaffold, adapter contract,
dev setup, and live smoke tests).
