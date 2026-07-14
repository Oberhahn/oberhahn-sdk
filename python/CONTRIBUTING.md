# Contributing to `oberhahn` (Python)

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

## Adding a provider

Adding a provider is a **one-file adapter** — the core wrapper and event mapping
never change; there is no detection to write.

Scaffold it:

```sh
python scripts/new_adapter.py <slug>   # writes the adapter + test stubs, registers it in oberhahn._registry
```

That leaves TODOs for the extraction logic. Then implement the `Adapter`
contract (`oberhahn._types`) — a `name` (the provider slug the caller passes to
`wrap`) plus a list of `MethodSpec`s, each with a `path` to monkey-patch and an
`extract()` (and `extract_stream()` for streaming methods) — and add a drift
canary for it in `tests/test_contract.py` so a future provider SDK bump that
renames a field fails CI.

> There's also an agent-driven flow: the repo ships an `/add-provider` Claude
> Code command that runs the scaffold, reads the provider SDK's real response
> shape, implements the extraction, writes tests, and verifies to green.

## Live smoke tests

Two scripts make a real (tiny, cheap) provider call against a **deployed**
OBERHAHN endpoint and read the event back. Config comes from `python/.env`
(auto-loaded; real environment variables still win):

```sh
python scripts/smoke.py          # one non-streaming call (openai | anthropic | bedrock)
python scripts/smoke_stream.py   # one streaming call (openai | anthropic)
```

Required env: `OBERHAHN_API_KEY`, `OBERHAHN_BASE_URL` (**incl. the `/v0`
suffix** — the smoke scripts read it directly, unlike the library which defaults
`base_url` to the hosted endpoint), and one provider credential
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / AWS creds). Force a provider with
`OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock`. An ingest-only `oak_` key
gets 403 on read-back — the script says so and treats it as non-fatal (verify
via the dashboard instead).
