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

const openai = wrap(new OpenAI(), "openai", {
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
- **`wrap(client, provider, opts?)`** — patch the named provider's usage-bearing
  methods in place and return the same client (typed as itself). `provider` is a
  registered slug (see `knownProviders()`). Idempotent — re-wrapping never
  double-emits. Throws on an unknown provider; warns (and no-ops) if the client
  carries none of that provider's methods.
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

> **Bedrock:** `send(command)` takes a `Command` *instance*, not a plain body,
> so attach per-call `obMetadata` to the command object itself
> (`Object.assign(cmd, { obMetadata: { … } })`). The SDK reads and removes it
> before `send()`, preserving the command instance. Per-client
> `wrap(client, "bedrock", { metadata })` and global `init` metadata work too.

> **Gemini:** wrap a `@google/genai` client and call
> `client.models.generateContent({ model, contents, obMetadata })` /
> `client.models.generateContentStream({ … })`. Attach per-call attribution with
> the ordinary `obMetadata` key on the request, like OpenAI/Anthropic.

## Extending it

The SDK is designed so **adding a provider is a one-file adapter** — the core
wrapper and event mapping never change. If you want to add a provider or hack on
the SDK, see [CONTRIBUTING.md](./CONTRIBUTING.md) (scaffold, adapter contract,
dev setup, and live smoke tests).
