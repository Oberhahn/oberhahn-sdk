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

oberhahn.init(api_key="oak_...")   # oak_… 

# Provider is auto-detected from the client.
client = oberhahn.wrap(
    OpenAI(),
    {"metadata": {"environment": "production", "feature": "support_agent"}},
)

client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    ob_metadata={"customer_id": "cust_123", "session_id": session_id, "turn_id": turn_id},
)
```

Works the same for `AsyncOpenAI` / `AsyncAnthropic` — `await` the call as usual.

## API

- **`init(*, api_key=None, metadata=None, …)`** — set global config with the
  keyword-only fields in [Config](#config) below (also read from env). Returns
  the client.
- **`wrap(client, options=None)`** — patch the provider's usage-bearing methods
  in place and return the same client. `options` is a dict (mirrors the JS
  `WrapOptions`): `{"provider": ..., "metadata": ...}`. `provider` is
  **auto-detected** from the client when omitted (`wrap(OpenAI())`); pass it
  explicitly when the client is ambiguous — e.g. an OpenAI-compatible client
  pointed at another host: `wrap(client, {"provider": "openrouter"})`.
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

**Global** — on `init`, applied to every event:

```python
oberhahn.init(api_key="oak_...", metadata={"environment": "production"})
```

**Per-client** — on `wrap`, applied to every call through that client:

```python
client = oberhahn.wrap(OpenAI(), {"metadata": {"feature": "support_agent"}})
```

**Per-call** — on the request itself, highest precedence:

```python
client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    ob_metadata={"session_id": "conv_9", "customer_id": "cust_123", "turn_id": 7},
)
```

The three merge into one event. Given the above, the event carries
`provider_session_id: "conv_9"` (`session_id` is a known key) and
`custom: {"environment": "production", "feature": "support_agent", "customer_id": "cust_123", "turn_id": "7"}`.

## Integrations

`wrap()` patches **every token-usage-bearing method** the provider SDK exposes;
every other method on the client is passed through **untouched** (still fully
usable — it just isn't metered, because it emits no usage). So you keep the
entire native SDK surface and only the calls that return token usage are
reported. Streaming is supported on every provider that streams — usage is read
from the final/aggregated chunk(s), so you must fully consume the stream.

Per-call attribution is always the same `ob_metadata=...` keyword argument
(merged over `wrap(client, {"metadata": ...})` and `init(metadata=...)`).

### Compatibility matrix

| Provider          | `wrap()` target                                     | Instrumented methods (streaming ✅)                                                     | Cache tokens   |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------- |
| **OpenAI**        | `OpenAI()` / `AsyncOpenAI()`                        | `chat.completions.create` ✅ · `responses.create` ✅ · `embeddings.create`               | read           |
| **Anthropic**     | `Anthropic()` / `AsyncAnthropic()`                  | `messages.create` ✅                                                                     | read + write   |
| **AWS Bedrock**   | `boto3.client("bedrock-runtime")`                   | `converse` · `converse_stream` ✅                                                        | read + write   |
| **Google Gemini** | `genai.Client()`                                    | `models.generate_content` · `models.generate_content_stream` ✅                          | read           |

Provider is **auto-detected** from the client, so `wrap(OpenAI())` is enough;
pass the slug explicitly (`wrap(client, {"provider": "openai"})`) only to be unambiguous.
`known_providers()` returns the live list.

### OpenAI

```sh
pip install "oberhahn[openai]"
```

```python
import oberhahn
from openai import OpenAI

oberhahn.init(api_key="oak_...")
client = oberhahn.wrap(OpenAI())

# Chat Completions
client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
    ob_metadata={"session_id": "sess_1", "customer_id": "cust_123"},
)

stream = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    ...

# Responses API and Embeddings are instrumented too.
client.responses.create(model="gpt-4o", input="Hello")
client.embeddings.create(model="text-embedding-3-small", input="Hello")
```

`AsyncOpenAI()` works identically — `await` the call (and `async for` the stream).

### OpenAI-compatible providers (OpenRouter, Together, Groq, …)

Providers that speak the OpenAI wire protocol are just the `OpenAI` client
pointed at a different `base_url`. Wrap that client and **name the provider
explicitly** — auto-detection can't tell them apart from OpenAI:

```python
import os
import oberhahn
from openai import OpenAI

oberhahn.init(api_key="oak_...")
client = oberhahn.wrap(
    OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"]),
    {"provider": "openrouter"},
)
client.chat.completions.create(model="openai/gpt-4o", messages=[{"role": "user", "content": "Hello"}])
```

The explicit slug is recorded on every event as **`custom.provider`** (the
routing layer), while `model_provider` stays what the OpenAI adapter reports — so
your dashboards can group by routing layer without losing the model vendor. A
user `ob_metadata={"provider": ...}` still wins on collision. Any
provider-reported **`cost`** in the usage block (e.g. OpenRouter's) is forwarded
to `spend_details.cost`; otherwise the server derives cost from tokens.

The recognized slugs are exported as `oberhahn.OPENAI_COMPATIBLE_PROVIDERS`:
`openrouter`, `together`, `fireworks`, `groq`, `deepinfra`, `perplexity`, `xai`,
`deepseek`, `mistral`, `azure`.

### Anthropic

```sh
pip install "oberhahn[anthropic]"
```

```python
import oberhahn
from anthropic import Anthropic

oberhahn.init(api_key="oak_...")
client = oberhahn.wrap(Anthropic())

client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
    ob_metadata={"session_id": "sess_1"},
)

stream = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for event in stream:
    ...
```

Anthropic reports both cache-read and cache-write tokens. `AsyncAnthropic()`
works identically.

### AWS Bedrock

```sh
pip install "oberhahn[bedrock]"
```

```python
import boto3
import oberhahn

oberhahn.init(api_key="oak_...")
client = oberhahn.wrap(boto3.client("bedrock-runtime", region_name="us-east-1"))

# Converse
client.converse(
    modelId="anthropic.claude-3-5-haiku-20241022-v1:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}],
    ob_metadata={"session_id": "sess_1"},
)

res = client.converse_stream(
    modelId="anthropic.claude-3-5-haiku-20241022-v1:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}],
)
for event in res["stream"]:
    ...
```

Bedrock is a hosting layer, so `model_provider` is set to the **real model
vendor** parsed from `modelId` (e.g. `anthropic`), and `custom.provider` records
that Bedrock routed the call. The optional cross-region inference-profile prefix
(`us.` / `eu.` / `apac.` / `us-gov.`) is stripped for pricing.

### Google Gemini

```sh
pip install "oberhahn[gemini]"
```

```python
import oberhahn
from google import genai

oberhahn.init(api_key="oak_...")
client = oberhahn.wrap(genai.Client())

client.models.generate_content(
    model="gemini-2.0-flash",
    contents="Hello",
    ob_metadata={"session_id": "sess_1"},
)

stream = client.models.generate_content_stream(model="gemini-2.0-flash", contents="Hello")
for chunk in stream:
    ...
```

Gemini models are priced under the `google` vendor, so `model_provider` is
`google` (the `gemini` slug is only the SDK/registry identity).
