# Contributing to `@oberhahn/sdk`

## Development

```sh
npm install
npm run typecheck   # tsc on src + tests (incl. the provider-SDK drift canaries)
npm test            # vitest
npm run build       # emit dist/
```

## Adding a provider

Adding a provider is a **one-file adapter** — the core wrapper and event mapping
never change; there is no detection to write.

Scaffold it:

```sh
node scripts/new-adapter.mjs <slug>   # writes the adapter + test stubs, registers it in src/registry.ts
```

That leaves TODOs for the extraction logic. Then implement the `Adapter`
contract (`src/adapters/types.ts`) — a `name` (the provider slug the caller
passes to `wrap`) plus a list of `MethodSpec`s, each with a `path` to
monkey-patch and an `extract()` (and `extractStream()` for streaming methods) —
and add a drift canary for it in `test/contract.test.ts` so a future provider
SDK bump that renames a field fails CI.

> There's also an agent-driven flow: the repo ships an `/add-provider` Claude
> Code command that runs the scaffold, reads the provider SDK's real response
> shape, implements the extraction, writes tests, and verifies to green.

## Live smoke tests

Two scripts make a real (tiny, cheap) provider call against a **deployed**
OBERHAHN endpoint and read the event back. Config comes from `js/.env`
(auto-loaded by the scripts; `process.env` still wins over the file):

```sh
npm run smoke          # one non-streaming call (openai | anthropic | bedrock)
npm run smoke:stream   # one streaming call (openai | anthropic)
```

Required env: `OBERHAHN_API_KEY`, `OBERHAHN_BASE_URL`, and one provider key
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / AWS creds). Force a provider with
`OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock`.

- **`OBERHAHN_BASE_URL` must include the `/v0` suffix** (e.g.
  `https://oberhahn.example.com/v0`). The smoke scripts read it directly and post
  to `{baseUrl}/events`; without `/v0` the ingest POST 404/403s. (The library
  itself defaults `baseUrl` to the hosted endpoint — this requirement is only for
  the smoke scripts.)
- **Read-back needs a read-capable key.** An ingest-only `oak_` key gets 403 on
  `GET /events` — the script says so and treats it as non-fatal (verify via the
  dashboard instead).
- If a var is already exported in your shell it shadows `js/.env` — `unset` it
  to fall back to the file.
