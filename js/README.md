# `@oberhahn/sdk`

A thin, server-side TypeScript SDK that wraps native provider SDKs, extracts
token usage + attribution from each call, and posts canonical events to
OBERHAHN's `POST /v0/events`.

Wrap your existing provider client once and keep calling it exactly as before —
the SDK captures token usage and attribution from each call and reports it to
OBERHAHN in the background. It stays out of the request path: no config to thread
through your call sites, no buffering, and failures never break your calls.

Supports OpenAI, Anthropic, AWS Bedrock, Google Gemini, and more — call
`knownProviders()` for the live list (it's the source of truth; new providers
are one-file adapters). Provider SDKs are *optional peer dependencies* — install
only what you use.

## Usage

```ts
import { init, wrap } from "@oberhahn/sdk";
import OpenAI from "openai";

init({ apiKey: process.env.OBERHAHN_API_KEY }); // oak_… key → org + consumer scope

// Provider is auto-detected from the client.
const openai = wrap(new OpenAI(), {
  metadata: { environment: "production", feature: "support_agent" },
});

await openai.chat.completions.create({
  model: "gpt-4o",
  messages,
  obMetadata: { customer_id: "cust_123", session_id, turn_id },
});
```

## API

- **`init(config)`** — set global config (also read from env). Returns the client.
- **`wrap(client, options?)`** — patch the provider's usage-bearing methods in
  place and return the same client (typed as itself). The provider is
  auto-detected from the client when omitted; pass it explicitly via
  `options.provider` when the client is ambiguous — e.g. an OpenAI-compatible
  client pointed at another host: `wrap(client, { provider: "openrouter" })`.
- **`obMetadata`** (or `ob_metadata`) on a request → per-call attribution;
  stripped from the args before the provider call is forwarded.
- **`flush()`** — await every event submitted so far. Optional: submission is
  *immediate* and fire-and-forget (nothing sits buffered), so a long-lived
  server never needs it. Call it in short-lived / serverless contexts (e.g. at
  the end of a Lambda handler) to drain before the runtime freezes the process.

Submission is fire-and-forget and best-effort — the wrapped request never waits
on it, and a delivery failure past `maxRetries` is dropped (surfaced via
`onError`), never thrown into your call path.

```ts
export async function handler(event) {
  const res = await openai.chat.completions.create({ model, messages });
  await flush();   // drain before the platform freezes this invocation
  return res;
}
```

### Config

| Field          | Env                   | Default | Purpose                                                        |
| -------------- | --------------------- | ------- | -------------------------------------------------------------- |
| `apiKey`       | `OBERHAHN_API_KEY`    | —       | `oak_` key; sent as `Authorization: Bearer`.                   |
| `metadata`     | —                     | `{}`    | Global attribution merged into every event.                   |
| `throwOnError` | —                     | `false` | Attribution failures must not break the request path.          |
| `enabled`      | `OBERHAHN_SDK_DISABLED` | `true`  | Kill switch (no-op passthrough when off).                      |
| `maxRetries`   | —                     | `2`     | Transient-failure retries (exponential backoff).               |
| `fetch`        | —                     | global  | Injectable transport (tests / custom).                         |

### Metadata routing

Global (`init`) + per-client (`wrap`) + per-call (`obMetadata`) metadata are
merged (later wins). Known keys map to canonical event fields
(`session_id` → `provider_session_id`, plus `task_id`, `consumer_id`,
`consumer_type`); everything else is coerced to strings and placed in `custom`.

## Integrations

`wrap()` patches **every token-usage-bearing method** the provider SDK exposes;
every other method on the client is passed through **untouched** (still fully
usable — it just isn't metered, because it emits no usage). So you keep the
entire native SDK surface and only the calls that return token usage are
reported. Streaming is supported on every provider that streams — usage is read
from the final/aggregated chunk(s), so you must fully consume the stream.

Per-call attribution is the same `obMetadata` key on the request (merged over
`wrap(client, { metadata })` and `init({ metadata })`) — except **Bedrock**,
whose `send(command)` takes a `Command` instance, so `obMetadata` goes on the
command object (see below).

### Compatibility matrix

| Provider          | `wrap()` target                          | Instrumented methods (streaming ✅)                                              | Cache tokens   |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------- | -------------- |
| **OpenAI**        | `new OpenAI()`                           | `chat.completions.create` ✅ · `responses.create` ✅ · `embeddings.create`        | read           |
| **Anthropic**     | `new Anthropic()`                        | `messages.create` ✅                                                              | read + write   |
| **AWS Bedrock**   | `new BedrockRuntimeClient()`             | `send(ConverseCommand)` · `send(ConverseStreamCommand)` ✅                        | read + write   |
| **Google Gemini** | `new GoogleGenAI()`                      | `models.generateContent` · `models.generateContentStream` ✅                     | read           |

Provider is **auto-detected** from the client, so `wrap(new OpenAI())` is enough;
pass the slug explicitly (`wrap(client, { provider: "openai" })`) only to be unambiguous.
`knownProviders()` returns the live list.

### OpenAI

```sh
npm install openai
```

```ts
import { init, wrap } from "@oberhahn/sdk";
import OpenAI from "openai";

init({ apiKey: process.env.OBERHAHN_API_KEY });
const openai = wrap(new OpenAI());

// Chat Completions
await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  obMetadata: { session_id: "sess_1", customer_id: "cust_123" },
});

// Streaming — set include_usage so the final chunk carries token usage,
// and consume the whole stream so the SDK sees it.
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  // …
}

// Responses API and Embeddings are instrumented too.
await openai.responses.create({ model: "gpt-4o", input: "Hello" });
await openai.embeddings.create({ model: "text-embedding-3-small", input: "Hello" });
```

### OpenAI-compatible providers (OpenRouter, Together, Groq, …)

Providers that speak the OpenAI wire protocol are just the `OpenAI` client
pointed at a different `baseURL`. Wrap that client and **name the provider
explicitly** — auto-detection can't tell them apart from OpenAI:

```ts
import { wrap } from "@oberhahn/sdk";
import OpenAI from "openai";

const client = wrap(
  new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }),
  { provider: "openrouter" },
);
await client.chat.completions.create({ model: "openai/gpt-4o", messages: [{ role: "user", content: "Hello" }] });
```

The explicit slug is recorded on every event as **`custom.provider`** (the
routing layer), while `model_provider` stays what the OpenAI adapter reports — so
your dashboards can group by routing layer without losing the model vendor. A
user `obMetadata: { provider: ... }` still wins on collision. Any
provider-reported **`cost`** in the usage block (e.g. OpenRouter's) is forwarded
to `spend_details.cost`; otherwise the server derives cost from tokens.

The recognized slugs are exported as `OPENAI_COMPATIBLE_PROVIDERS`: `openrouter`,
`together`, `fireworks`, `groq`, `deepinfra`, `perplexity`, `xai`, `deepseek`,
`mistral`, `azure`.

### Anthropic

```sh
npm install @anthropic-ai/sdk
```

```ts
import { wrap } from "@oberhahn/sdk";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = wrap(new Anthropic());

await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
  obMetadata: { session_id: "sess_1" },
});

// Streaming with stream: true — usage is split across message_start /
// message_delta events; the SDK reassembles it once the stream is consumed.
const stream = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const event of stream) {
  // …
}
```

Anthropic reports both cache-read and cache-write tokens.

### AWS Bedrock

```sh
npm install @aws-sdk/client-bedrock-runtime
```

`send(command)` takes a `Command` **instance**, not a plain body, so attach
per-call `obMetadata` to the command object itself. The SDK reads and removes it
before `send()`, preserving the command instance.

```ts
import { wrap } from "@oberhahn/sdk";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = wrap(new BedrockRuntimeClient({ region: "us-east-1" }));

// Converse
const cmd = new ConverseCommand({
  modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
  messages: [{ role: "user", content: [{ text: "Hello" }] }],
});
Object.assign(cmd, { obMetadata: { session_id: "sess_1" } });
await client.send(cmd);

// Streaming — use ConverseStreamCommand and drain the stream.
const streamCmd = new ConverseStreamCommand({
  modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
  messages: [{ role: "user", content: [{ text: "Hello" }] }],
});
const res = await client.send(streamCmd);
for await (const event of res.stream) {
  // …
}
```

Bedrock is a hosting layer, so `model_provider` is set to the **real model
vendor** parsed from `modelId` (e.g. `anthropic`), and `custom.provider` records
that Bedrock routed the call. The optional cross-region inference-profile prefix
(`us.` / `eu.` / `apac.` / `us-gov.`) is stripped for pricing.

### Google Gemini

```sh
npm install @google/genai
```

```ts
import { wrap } from "@oberhahn/sdk";
import { GoogleGenAI } from "@google/genai";

const genai = wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

await genai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Hello",
  obMetadata: { session_id: "sess_1" },
});

// Streaming is a separate method; consume every chunk.
const stream = await genai.models.generateContentStream({
  model: "gemini-2.0-flash",
  contents: "Hello",
});
for await (const chunk of stream) {
  // …
}
```

Gemini models are priced under the `google` vendor, so `model_provider` is
`google` (the `gemini` slug is only the SDK/registry identity).
