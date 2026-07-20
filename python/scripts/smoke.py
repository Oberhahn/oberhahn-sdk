#!/usr/bin/env python3
"""Live smoke test for `oberhahn` against a DEPLOYED OBERHAHN endpoint: makes
ONE real provider call, lets the SDK post the usage event, reads it back, and
verifies the attribution round-tripped.

    python scripts/smoke.py                one non-streaming call (env-driven)
    python scripts/smoke.py --stream       one streaming call
    python scripts/smoke.py --interactive  prompt for provider / key / model / streaming
    python scripts/smoke.py --all          every provider with creds, both modes

Env (loaded from python/.env automatically; real environment variables win):
    Required: OBERHAHN_BASE_URL (incl. /v0), OBERHAHN_API_KEY, one provider key
              (OPENAI_API_KEY / ANTHROPIC_API_KEY / AWS creds / GEMINI_API_KEY).
    Optional: OPENAI_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL / BEDROCK_MODEL_ID,
              OBERHAHN_SMOKE_PROVIDER.

Makes a real (tiny, cheap) API call and writes a real event, so run it
deliberately. Per-provider call logic lives in smoke_providers.py.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from smoke_providers import SMOKE_PROVIDERS, choose_provider, die, run_smoke


def load_env_file() -> None:
    """Load python/.env (sibling of scripts/) without a dotenv dependency.
    Real environment variables still win — anything already set is left alone.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(here, "..", ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()

import oberhahn  # noqa: E402  (after path/env setup)

# ---------------------------------------------------------------------------
# Harness: real call → post event → read back → verify attribution.
# ---------------------------------------------------------------------------

# Route each sent key to where it should surface on the read-back event,
# mirroring oberhahn._metadata; everything else lands in custom.*.
KNOWN_FIELD = {
    "session_id": "provider_session_id",
    "provider_session_id": "provider_session_id",
    "task_id": "task_id",
    "consumer_id": "consumer_id",
    "consumer_type": "consumer_type",
}


def metadata_mismatches(row: Dict[str, Any], meta: Dict[str, Any]) -> List[str]:
    miss: List[str] = []
    for key, val in meta.items():
        want = str(val)
        field = KNOWN_FIELD.get(key)
        got = row.get(field) if field else (row.get("custom") or {}).get(key)
        where = field if field else f"custom.{key}"
        if str(got if got is not None else "") != want:
            shown = "(missing)" if got is None else f'"{got}"'
            miss.append(f'{where}: expected "{want}", got {shown}')
    return miss


def read_back(base: str, key: str, smoke_id: str) -> Optional[List[Dict[str, Any]]]:
    """Poll GET /events filtered by our custom tag. Returns rows, [] if none
    found, or None if reading isn't permitted (ingest-only key)."""
    import urllib.error
    import urllib.parse
    import urllib.request

    query = urllib.parse.urlencode({"filter": f"smoke_id:{smoke_id}", "limit": 5})
    url = f"{base.rstrip('/')}/events?{query}"
    for _ in range(5):
        req = urllib.request.Request(url, headers={"authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                sys.stderr.write(
                    f"\n  readback not permitted ({err.code}) — an ingest-only key "
                    "can't read /events.\n  The event may still have landed; verify "
                    "with a read key or the dashboard.\n"
                )
                return None
            time.sleep(1)
            continue
        rows = body if isinstance(body, list) else body.get("events", [])
        if rows:
            return rows
        time.sleep(1)
    return []


def make_smoke_metadata(smoke_id: str, streaming: bool) -> Dict[str, Any]:
    return {
        # known keys → canonical top-level event fields
        "session_id": smoke_id,
        "task_id": f"task_{smoke_id}",
        "consumer_type": "customer",
        # custom keys → event.custom.* (each backs a dashboard dimension)
        "smoke_id": smoke_id,
        "feature": "sdk_smoke_stream" if streaming else "sdk_smoke",
        "task": "SDK metadata smoke",
        "task_team": "Platform",
        "task_project": "SDK",
        "client_tool": "smoke-cli",
        "environment": "staging",
    }


def _require_endpoint() -> Tuple[str, str]:
    base = os.environ.get("OBERHAHN_BASE_URL")
    key = os.environ.get("OBERHAHN_API_KEY")
    if not base:
        die("OBERHAHN_BASE_URL is not set (deployed API root incl. /v0).")
    if not key:
        die("OBERHAHN_API_KEY is not set (an oak_ key for the deployment).")
    return base, key


_client = None


def _oberhahn_client():
    """Init the global OBERHAHN client once (idempotent across smoke runs)."""
    global _client
    if _client is None:
        base, key = _require_endpoint()
        _client = oberhahn.init(
            api_key=key,
            base_url=base,
            throw_on_error=False,
            on_error=lambda err: print("  submit error:", err),
        )
    return _client


def run_smoke_test(streaming: bool, provider: Optional[str] = None) -> None:
    """Run the end-to-end smoke for one provider/mode; exits non-zero on failure."""
    base, key = _require_endpoint()
    smoke_id = f"smoke_{int(time.time())}_{random.randint(0, 1_000_000)}"
    meta = make_smoke_metadata(smoke_id, streaming)

    print(f"OBERHAHN smoke test{' (streaming)' if streaming else ''}")
    print(f"  endpoint : {base}")
    print(f"  key      : {key[:8]}…")
    print(f"  smoke_id : {smoke_id}")

    client = _oberhahn_client()
    provider = provider or choose_provider()

    print(f"\n→ making real{' streaming' if streaming else ''} provider call…")
    message_id, usage = run_smoke(provider, streaming, meta)
    if message_id:
        print(f"  provider returned id={message_id}")
    if usage:
        print(f"  usage: {usage}")

    print("\n→ waiting for the event POST to complete…")
    client.await_pending()

    print("\n→ reading the event back from OBERHAHN…")
    rows = read_back(base, key, smoke_id)
    if rows is None:
        return  # readback not permitted; not an ingest failure
    if not rows:
        die("event NOT found on readback — check the endpoint, key scope, and logs.")
    print(f"\n✓ event landed. matched {len(rows)} row(s):")
    print(json.dumps(rows[0], indent=2, default=str))

    miss = metadata_mismatches(rows[0], meta)
    if miss:
        die("metadata did NOT round-trip:\n    - " + "\n    - ".join(miss))
    print(f"\n✓ all {len(meta)} attribution fields round-tripped.")


# ---------------------------------------------------------------------------
# --all: run every provider with credentials in both modes, summarize.
# ---------------------------------------------------------------------------

# Which env vars mean "this provider is usable". Keys mirror SMOKE_PROVIDERS.
_HAS_CREDS = {
    "openai": lambda: bool(os.environ.get("OPENAI_API_KEY")),
    "anthropic": lambda: bool(os.environ.get("ANTHROPIC_API_KEY")),
    "bedrock": lambda: bool(
        os.environ.get("AWS_ACCESS_KEY_ID")
        or os.environ.get("AWS_PROFILE")
        or os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
        or os.environ.get("AWS_REGION")
    ),
    "gemini": lambda: bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")),
    "openrouter": lambda: bool(os.environ.get("OPENROUTER_API_KEY")),
}

PASS, SENT, FAIL = "PASS", "SENT (unverified)", "FAIL"


def _available_providers() -> List[str]:
    return [p for p in SMOKE_PROVIDERS if _HAS_CREDS.get(p, lambda: False)()]


def _run_one(base: str, key: str, provider: str, streaming: bool) -> Tuple[str, str]:
    """Run one provider/mode end-to-end, isolating failure. Returns (status, detail)."""
    smoke_id = f"smoke_{int(time.time())}_{random.randint(0, 1_000_000)}"
    meta = make_smoke_metadata(smoke_id, streaming)
    label = f"{provider}{' (streaming)' if streaming else ''}"
    print(f"\n{'=' * 64}\n▶ {label}\n  smoke_id : {smoke_id}")
    try:
        print("  → making real provider call…")
        message_id, usage = run_smoke(provider, streaming, meta)
        if message_id:
            print(f"    provider returned id={message_id}")
        if usage:
            print(f"    usage: {usage}")
        print("  → waiting for the event POST to complete…")
        _oberhahn_client().await_pending()
        print("  → reading the event back from OBERHAHN…")
        rows = read_back(base, key, smoke_id)
        if rows is None:
            return SENT, "readback not permitted (ingest-only key)"
        if not rows:
            return FAIL, "event NOT found on readback"
        miss = metadata_mismatches(rows[0], meta)
        if miss:
            return FAIL, "metadata did NOT round-trip: " + "; ".join(miss)
        return PASS, f"{len(meta)} attribution fields round-tripped"
    except Exception as exc:  # noqa: BLE001 — one run's failure must not abort the suite
        return FAIL, f"{type(exc).__name__}: {exc}"


def run_all() -> None:
    """Run every provider with credentials, both modes, then print a summary."""
    base, key = _require_endpoint()
    avail = _available_providers()
    print("OBERHAHN smoke runner (--all)")
    print(f"  endpoint : {base}")
    print(f"  key      : {key[:8]}…")
    if not avail:
        die(
            "No provider credentials found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, "
            "AWS creds, or GEMINI_API_KEY."
        )
    _oberhahn_client()
    plan = [(p, s) for p in avail for s in (False, True)]
    print(f"\nRunning {len(plan)} smoke test(s): " + ", ".join(p + ("/stream" if s else "") for p, s in plan))

    results = [(p, s, *_run_one(base, key, p, s)) for p, s in plan]

    print(f"\n{'=' * 64}\nSUMMARY\n{'=' * 64}")
    mark = {PASS: "✓", SENT: "~", FAIL: "✗"}
    for provider, streaming, status, detail in results:
        label = f"{provider}{' (streaming)' if streaming else ''}"
        print(f"  {mark[status]} {label:<24} {status:<18} {detail}")
    passed = sum(1 for r in results if r[2] == PASS)
    sent = sum(1 for r in results if r[2] == SENT)
    failed = [r for r in results if r[2] == FAIL]
    print(f"\n  {passed} passed, {sent} sent-unverified, {len(failed)} failed of {len(results)} total.")
    if failed:
        sys.exit(1)


# ---------------------------------------------------------------------------
# --interactive: prompt for provider / key(s) / model / streaming, then run.
# ---------------------------------------------------------------------------

# One entry per provider. `fields` are the credentials to collect. Mirrors
# smoke_providers.py and js/scripts/smoke.mjs.
CONFIG = {
    "openai": {
        "label": "OpenAI",
        "fields": [{"name": "OPENAI_API_KEY", "prompt": "OpenAI API key"}],
        "model": {"name": "OPENAI_MODEL", "default": "gpt-4o-mini"},
    },
    "anthropic": {
        "label": "Anthropic",
        "fields": [{"name": "ANTHROPIC_API_KEY", "prompt": "Anthropic API key"}],
        "model": {"name": "ANTHROPIC_MODEL", "default": "claude-haiku-4-5"},
    },
    "bedrock": {
        "label": "AWS Bedrock",
        # AWS credentials come from the standard AWS chain (env / profile / bearer
        # token / role), not prompts — we only need the region here.
        "fields": [{"name": "AWS_REGION", "prompt": "AWS region (e.g. us-east-1)"}],
        "model": {"name": "BEDROCK_MODEL_ID", "default": "anthropic.claude-3-5-haiku-20241022-v1:0"},
    },
    "gemini": {
        "label": "Google Gemini",
        "fields": [{"name": "GEMINI_API_KEY", "prompt": "Gemini API key"}],
        "model": {"name": "GEMINI_MODEL", "default": "gemini-2.0-flash"},
    },
    "openrouter": {
        "label": "OpenRouter (OpenAI-compatible)",
        "fields": [
            {"name": "OPENROUTER_API_KEY", "prompt": "OpenRouter API key"},
            {"name": "OPENROUTER_BASE_URL", "prompt": "OpenRouter base URL", "default": "https://openrouter.ai/api/v1"},
        ],
        "model": {"name": "OPENROUTER_MODEL", "default": "openai/gpt-4o-mini"},
    },
}


def _collect(field: Dict[str, Any]) -> str:
    """Prompt for one field — but skip entirely when it's already set (from .env
    or the environment). A field may carry a `default` (offered on enter)."""
    name = field["name"]
    if os.environ.get(name):
        print(f"  using {name} from the environment")
        return os.environ[name]
    dflt = field.get("default")
    hint = f" [enter for {dflt}]" if dflt else ""
    while True:
        answer = input(f"{field['prompt']}{hint}: ").strip()
        if answer:
            return answer
        if dflt:
            return dflt
        print("  (required)")


def run_interactive() -> None:
    slugs = list(CONFIG)
    print("OBERHAHN interactive smoke test\n\nSelect a provider:")
    for i, slug in enumerate(slugs, 1):
        print(f"  {i}) {CONFIG[slug]['label']}")
    provider = slugs[0]
    while True:
        choice = input("Provider [1]: ").strip()
        if choice == "":
            break
        if choice.isdigit() and 1 <= int(choice) <= len(slugs):
            provider = slugs[int(choice) - 1]
            break
        if choice.lower() in slugs:
            provider = choice.lower()
            break
        print(f"  pick 1–{len(slugs)} (or a name: {', '.join(slugs)})")

    cfg = CONFIG[provider]
    print(f"\n→ {cfg['label']}\n")

    for field in cfg["fields"]:
        os.environ[field["name"]] = _collect(field)
    if cfg.get("model"):
        current = os.environ.get(cfg["model"]["name"]) or cfg["model"]["default"]
        os.environ[cfg["model"]["name"]] = input(f"Model [enter for {current}]: ").strip() or current
    streaming = input("Streaming? [y/N]: ").strip().lower() in ("y", "yes")

    # OBERHAHN endpoint + key: reuse from env when present, else prompt.
    if not os.environ.get("OBERHAHN_BASE_URL"):
        os.environ["OBERHAHN_BASE_URL"] = input("OBERHAHN base URL (incl. /v0): ").strip()
    if not os.environ.get("OBERHAHN_API_KEY"):
        os.environ["OBERHAHN_API_KEY"] = input("OBERHAHN oak_ key: ").strip()
    os.environ["OBERHAHN_SMOKE_PROVIDER"] = provider

    print(f"\n→ running {cfg['label']} smoke{' (streaming)' if streaming else ''}\n")
    run_smoke_test(streaming, provider)


# ---------------------------------------------------------------------------

def main() -> None:
    args = set(sys.argv[1:])
    if "--interactive" in args:
        run_interactive()
    elif "--all" in args:
        run_all()
    else:
        run_smoke_test("--stream" in args)


if __name__ == "__main__":
    main()
