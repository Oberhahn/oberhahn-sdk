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

## Live smoke tests

One script makes a real (tiny, cheap) provider call against a **deployed**
OBERHAHN endpoint and reads the event back. Config comes from `python/.env`
(auto-loaded; real environment variables still win):

```sh
python scripts/smoke.py                # one non-streaming call (env-driven)
python scripts/smoke.py --stream       # one streaming call
python scripts/smoke.py --interactive  # prompt for provider / key / model / streaming
python scripts/smoke.py --all          # every provider with creds, both modes
```

Required env: `OBERHAHN_API_KEY`, `OBERHAHN_BASE_URL` (**incl. the `/v0`
suffix** — the smoke scripts read it directly, unlike the library which defaults
`base_url` to the hosted endpoint), and one provider credential
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / AWS creds). Force a provider with
`OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock`. An ingest-only `oak_` key
gets 403 on read-back — the script says so and treats it as non-fatal (verify
via the dashboard instead).
