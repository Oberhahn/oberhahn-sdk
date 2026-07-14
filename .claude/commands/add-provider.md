---
description: Add a new provider SDK adapter (both languages), fully implemented and tested.
argument-hint: <slug> <sdk-package(s)> [notes/docs URL]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, WebFetch
---

You are adding a new provider to the OBERHAHN SDK. The goal is a **complete,
tested, one-file-per-language adapter** — not stubs. Arguments: `$ARGUMENTS`
(the provider slug, e.g. `cohere`; the provider SDK package(s), e.g. `cohere` /
`@cohere-ai/...`; and any docs URL or notes).

## Read the spec first

`SPECS.md` (repo root) is the source of truth — the canonical event contract, the
adapter contract, the token/cache rules, and the per-provider mapping table. Read
it before writing anything; this playbook is how to *apply* it.

## Non-negotiable design rules (read before writing code)

- **The SDK is thin.** An adapter only *extracts* `{ model, model_provider,
  input/output/cache tokens, ids }`. It **never computes cost** — the OBERHAHN
  server derives that. Do not add pricing, org/consumer/date logic.
- **One file per language.** Touch only the new `adapters/<slug>` file, the
  registry (via the scaffold), the provider dep, the test, and the contract
  canary. **Do not modify** the core wrapper, event builder, client, or metadata
  routing (`_wrap`/`wrap.ts`, `_event`/`event.ts`, `_client`/`client.ts`,
  `_metadata`/`metadata.ts`).
- **Match the existing adapters' style exactly** — read `openai` and `anthropic`
  in both languages first and mirror their structure, helpers (`get`,
  `coalesce`), and comment density.

## Step 1 — Scaffold (deterministic; don't hand-write these files)

```sh
cd python && python scripts/new_adapter.py <slug>
cd ../js && node scripts/new-adapter.mjs <slug>
```

This creates the adapter + test stubs and registers the adapter in both
registries. Everything below fills in the TODOs the scaffold left.

## Step 2 — Learn the provider's real response shape

Do NOT guess field names. Establish the ground truth:
- Read the provider SDK's usage/response types (installed package source, or its
  docs — use WebFetch on the notes URL if given).
- Identify, for each usage-bearing method: the **method path** to patch (e.g.
  `chat.create`), the **model** field, the **response id**, and the usage fields
  for **input tokens, output tokens, and cache read/write** (names differ per
  provider — e.g. OpenAI `prompt_tokens` includes cached and must be subtracted;
  Anthropic `input_tokens` is cache-exclusive). Note the **streaming** shape
  (which event/chunk carries usage) if the method can stream.

Write down the mapping before coding, and encode any non-obvious quirk as a code
comment (see the OpenAI adapter's cache-subtraction note for the bar).

## Step 3 — Implement the adapter (both languages)

Fill in `extract` (+ `is_stream`/`extract_stream` if it streams, else delete
them), set the real `MethodSpec.path`(s), and add `model_info` if the provider
names its model somewhere other than `kwargs["model"]` / `args[0].model` (needed
for correct `status:"error"` events). Use `get()`/`coalesce()` so the code works
against both SDK objects and plain dicts.

## Step 4 — Wire up the dependency

- **Python**: pin the package in `python/requirements-dev.txt` (exact `==`, so
  Dependabot bumps it) and add a loose `[<slug>] = ["<pkg>>=X"]` extra in
  `pyproject.toml`.
- **JS**: add the package to `devDependencies` (pinned `^`) and
  `peerDependencies` (`*`, optional) in `js/package.json`, then `npm install`.

## Step 5 — Tests + drift canary

- Un-skip the scaffolded test and write a real one: a hand-built fake whose
  method path returns a result with the provider's usage shape; assert the
  posted `spend_details` (mirror `test_openai` / `openai.test.ts`).
- Add a **drift canary** in `tests/test_contract.py` / `test/contract.test.ts`
  that reads the exact fields your adapter depends on off the *real* provider
  types (guard Python with `importorskip`), so a future SDK bump that renames a
  field fails CI.

## Step 5b — Live-smoke gate + credential request (the credential boundary)

You do NOT have (and must never ask for) the provider's API key. Everything
above is credential-free and should make CI green on its own — that green, via
the drift canaries against the real SDK types, is what proves the adapter is
correct. The live smoke is the only credentialed step, and it's handled by a
gated CI job + a request to a human. So:

1. Add a `<slug>` job to `.github/workflows/live-smoke.yml`, mirroring an
   existing provider: gate it on the provider's secret(s) (bash `-z` early-exit,
   never an `if:` that could leak), and fan out over python + js, and over
   non-stream + stream **only if this provider has a streaming method** (check
   whether the adapter set `is_stream`/`extract_stream`). One secret per provider
   covers both SDKs and both modes.
2. On the PR, add the labels **`needs-credentials`** and **`live-smoke`**, and
   post a single structured comment so a human can close the loop:
   > New provider **<slug>** — adapter + drift canaries are green (correctness
   > verified without credentials). To run the live smoke, add a repo/org secret
   > **`<SLUG>_API_KEY`** (mint at <provider console URL>, minimal/read scope,
   > ~$X per run). Once it's set, re-run the `live-smoke` workflow and it will
   > confirm the end-to-end path. I never see the key — it's injected only into
   > the gated CI job.

   Never put a real key in the repo, a fixture, or a comment. The human adds it
   as a secret; the gated job (not you) uses it.

## Step 6 — Verify to green (do not stop until this passes)

```sh
cd python && .venv/bin/python -m pytest -q
cd ../js && npm run typecheck && npm test
```

Then confirm the wrapper actually patches a real client instance:
`wrap(new <Provider>(...), "<slug>")` and check the method carries
`_oberhahn_wrapped`.

## Step 7 — Report

Summarize: the fields you mapped (with any quirk), files changed, dep versions
pinned, and the passing test/typecheck output. Note anything you couldn't verify
live (e.g. no API key) so a human can close the loop with a smoke run.
