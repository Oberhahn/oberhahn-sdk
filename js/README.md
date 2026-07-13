# `@oberhahn/sdk`

A thin, server-side TypeScript SDK that wraps native provider SDKs, extracts
token usage + attribution from each call, and posts canonical events to
OBERHAHN's `POST /v0/events`.

Wrap your existing provider client once and keep calling it exactly as before —
the SDK captures token usage and attribution from each call and reports it to
OBERHAHN in the background. It stays out of the request path: no config to thread
through your call sites, no buffering, and failures never break your calls.

Phase 1 providers: **OpenAI, Anthropic, AWS Bedrock**. Provider SDKs are
*optional peer dependencies* — install only what you use.

## Usage

```ts
import { init, wrap } from "@oberhahn/sdk";
import OpenAI from "openai";

init({
  apiKey: process.env.OBERHAHN_API_KEY,        // oak_… key → org + consumer scope
  baseUrl: "https://oberhahn.example.com/v0",  // API root incl. /v0
});

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
- **`wrap(client, provider, opts?)`** — patch the named provider's
  (`"openai"` | `"anthropic"` | `"bedrock"`) usage-bearing methods in place, and
  return the same client (typed as itself). Idempotent — re-wrapping never
  double-emits. Throws on an unknown provider; warns (and no-ops) if the client
  carries none of that provider's methods.
- **`obMetadata`** (or `ob_metadata`) on a request → per-call attribution;
  stripped from the args before the provider call is forwarded.

There is **no `flush`**: submission is *immediate* (serverless-safe — nothing
sits buffered waiting for a drain).

### Config

| Field          | Env                   | Default | Purpose                                                        |
| -------------- | --------------------- | ------- | -------------------------------------------------------------- |
| `apiKey`       | `OBERHAHN_API_KEY`    | —       | `oak_` key; sent as `Authorization: Bearer`.                   |
| `baseUrl`      | `OBERHAHN_BASE_URL`   | —       | API root incl. `/v0`.                                          |
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

## Adding a provider

Implement the `Adapter` contract (`src/adapters/types.ts`) — a `name` (the
provider slug the caller passes to `wrap`) plus a list of `MethodSpec`s, each
with a `path` to monkey-patch and an `extract()` (and `extractStream()` for
streaming methods) — and register it under its slug in `src/registry.ts`. The
core wrapper and event mapping are untouched; there is no detection to write.

## Development

```sh
npm install
npm run typecheck   # tsc on src
npm test            # vitest
npm run build       # emit dist/
```

## Live smoke tests

Two scripts make a real (tiny, cheap) provider call against a **deployed**
OBERHAHN endpoint and read the event back. Config comes from `sdk/.env`
(auto-loaded by the scripts; `process.env` still wins over the file):

```sh
npm run smoke          # one non-streaming call (openai | anthropic | bedrock)
npm run smoke:stream   # one streaming call (openai | anthropic)
```

Required env: `OBERHAHN_API_KEY`, `OBERHAHN_BASE_URL`, and one provider key
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / AWS creds). Force a provider with
`OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock`.

- **`OBERHAHN_BASE_URL` must include the `/v0` suffix** (e.g.
  `https://oberhahn.example.com/v0`). The SDK posts to `{baseUrl}/events`; without
  `/v0` the ingest POST 404/403s.
- **Read-back needs a read-capable key.** An ingest-only `oak_` key gets 403 on
  `GET /events` — the script says so and treats it as non-fatal (verify via the
  dashboard instead).
- If a var is already exported in your shell it shadows `sdk/.env` — `unset` it
  to fall back to the file.
