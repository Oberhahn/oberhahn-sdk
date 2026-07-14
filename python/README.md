# `oberhahn` (Python)

A thin, server-side Python SDK that wraps native provider SDKs, extracts token
usage + attribution from each call, and posts canonical events to OBERHAHN's
`POST /v0/events`.

Wrap your existing provider client once and keep calling it exactly as before —
the SDK captures token usage and attribution from each call and reports it to
OBERHAHN in the background. It stays out of the request path: no config to thread
through your call sites, no buffering, and failures never break your calls.

Phase 1 providers: **OpenAI, Anthropic, AWS Bedrock**. Provider SDKs are
*optional* — install only what you use.

## Install

```sh
pip install oberhahn                 # core (no provider SDKs)
pip install "oberhahn[openai]"       # + openai
pip install "oberhahn[anthropic]"    # + anthropic
pip install "oberhahn[bedrock]"      # + boto3
```

The core package has **no required dependencies** (standard library only).

## Usage

```python
import oberhahn
from openai import OpenAI

oberhahn.init(api_key="oak_...")   # oak_… key → org + consumer scope

client = oberhahn.wrap(
    OpenAI(),
    "openai",
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
- **`wrap(client, provider, *, metadata=None)`** — patch the named provider's
  (`"openai"` | `"anthropic"` | `"bedrock"`) usage-bearing methods in place, and
  return the same client. Idempotent — re-wrapping never double-emits. Raises on an
  unknown provider; warns (and no-ops) if the client carries none of that
  provider's methods.
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
| `base_url`       | `OBERHAHN_BASE_URL`     | `https://app.oberhahn.com/v0` | API root incl. `/v0`. Override for self-hosted/staging. |
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

## Adding a provider

Scaffold it — `python scripts/new_adapter.py <slug>` writes the adapter + test
stubs and registers it in `oberhahn._registry`, leaving TODOs for the extraction
logic. Then fill those in:

Implement the `Adapter` contract (`oberhahn._types`) — a `name` (the provider
slug the caller passes to `wrap`) plus a list of `MethodSpec`s, each with a
`path` to monkey-patch and an `extract()` (and `extract_stream()` for streaming
methods) — and register it under its slug in `oberhahn._registry`. The core
wrapper and event mapping are untouched; there is no detection to write.

## Development

```sh
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # pinned provider SDKs + test tooling
pip install -e .
pytest                                 # wiring suite + provider-SDK drift canaries
```

`requirements-dev.txt` pins the provider SDKs to exact versions so Dependabot can
bump them (each bump reruns the drift canaries in CI); the published
`[openai]` / `[anthropic]` / `[bedrock]` extras stay loose for consumers.

## Live smoke tests

Two scripts make a real (tiny, cheap) provider call against a **deployed**
OBERHAHN endpoint and read the event back. Config comes from `python/.env`
(auto-loaded; real environment variables still win):

```sh
python scripts/smoke.py          # one non-streaming call (openai | anthropic | bedrock)
python scripts/smoke_stream.py   # one streaming call (openai | anthropic)
```

Required env: `OBERHAHN_API_KEY`, `OBERHAHN_BASE_URL` (**incl. the `/v0`
suffix**), and one provider credential (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
AWS creds). Force a provider with `OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock`.
An ingest-only `oak_` key gets 403 on read-back — the script says so and treats
it as non-fatal (verify via the dashboard instead).
