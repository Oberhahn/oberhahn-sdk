"""Shared helpers for the live smoke scripts.

Everything comes from env vars — no secrets in code. These make a real (tiny,
cheap) API call and write a real event to the DEPLOYED endpoint, so run them
deliberately.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

# Make the local package importable without an install (mirrors `npm run smoke`
# building dist/ first — here we just add src/ to the path).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "src"))


def load_env_file() -> None:
    """Load python/.env (sibling of scripts/) without a dotenv dependency.
    Real environment variables still win — anything already set is left alone.
    """
    env_path = os.path.join(_HERE, "..", ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def die(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    sys.stderr.write(f"\n✗ {msg}\n\n")
    sys.exit(1)


# Route each sent key to where it should surface on the read-back event,
# mirroring oberhahn._metadata.
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
    query = urllib.parse.urlencode({"filter": f"smoke_id:{smoke_id}", "limit": 5})
    url = f"{base.rstrip('/')}/events?{query}"
    for _ in range(5):
        req = urllib.request.Request(url, headers={"authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
                import json

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


def choose_provider() -> str:
    forced = os.environ.get("OBERHAHN_SMOKE_PROVIDER")
    if forced:
        return forced
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE") or os.environ.get("AWS_REGION"):
        return "bedrock"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    die(
        "No provider selected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS creds, or "
        "GEMINI_API_KEY (or force with OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock|gemini)."
    )


def make_smoke_metadata(smoke_id: str) -> Dict[str, Any]:
    return {
        # known keys → canonical top-level event fields
        "session_id": smoke_id,
        "task_id": f"task_{smoke_id}",
        "consumer_type": "customer",
        # custom keys → event.custom.* (each backs a dashboard dimension)
        "smoke_id": smoke_id,
        "feature": "sdk_smoke",
        "task": "SDK metadata smoke",
        "task_team": "Platform",
        "task_project": "SDK",
        "client_tool": "smoke-cli",
        "environment": "staging",
    }


# --- provider smoke runners ---------------------------------------------------
# ONE entry per provider covers BOTH smoke scripts (non-stream + stream). Adding
# a provider = one entry here, not a runner in each of smoke.py / smoke_stream.py.
# Each returns (provider_message_id | None, usage | None); streaming returns
# (None, None) — usage is extracted from the stream by the SDK and confirmed on
# read-back. `oberhahn.wrap()` uses the global client the calling script init()'d.

_PROMPT = "Give me a 200 word paragraph."


def _openai(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from openai import OpenAI

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = oberhahn.wrap(OpenAI(), "openai")
    print(f"  provider : openai ({model}{', streaming' if streaming else ''})")
    args = dict(model=model, max_tokens=100, messages=[{"role": "user", "content": _PROMPT}], ob_metadata=meta)
    if streaming:
        stream = client.chat.completions.create(**args, stream=True, stream_options={"include_usage": True})
        print(f"  consumed {sum(1 for _ in stream)} chunk(s)")
        return None, None
    res = client.chat.completions.create(**args)
    return res.id, res.usage


def _anthropic(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from anthropic import Anthropic

    model = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
    client = oberhahn.wrap(Anthropic(), "anthropic")
    print(f"  provider : anthropic ({model}{', streaming' if streaming else ''})")
    args = dict(model=model, max_tokens=100, messages=[{"role": "user", "content": _PROMPT}], ob_metadata=meta)
    if streaming:
        stream = client.messages.create(**args, stream=True)
        print(f"  consumed {sum(1 for _ in stream)} event(s)")
        return None, None
    res = client.messages.create(**args)
    return res.id, res.usage


def _bedrock(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        die("Set AWS_REGION for the Bedrock smoke (plus AWS credentials).")
    model_id = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-5-haiku-20241022-v1:0")
    client = oberhahn.wrap(boto3.client("bedrock-runtime", region_name=region), "bedrock")
    print(f"  provider : bedrock ({model_id}, {region}{', streaming' if streaming else ''})")
    args = dict(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": _PROMPT}]}],
        inferenceConfig={"maxTokens": 16},
        ob_metadata=meta,
    )
    if streaming:
        res = client.converse_stream(**args)
        print(f"  consumed {sum(1 for _ in res['stream'])} event(s)")
        return None, None
    res = client.converse(**args)
    return None, res.get("usage")


def _gemini(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from google import genai

    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    client = oberhahn.wrap(genai.Client(), "gemini")
    print(f"  provider : gemini ({model}{', streaming' if streaming else ''})")
    if streaming:
        stream = client.models.generate_content_stream(model=model, contents=_PROMPT, ob_metadata=meta)
        print(f"  consumed {sum(1 for _ in stream)} chunk(s)")
        return None, None
    res = client.models.generate_content(model=model, contents=_PROMPT, ob_metadata=meta)
    return getattr(res, "response_id", None), res.usage_metadata


SMOKE_PROVIDERS = {
    "openai": _openai,
    "anthropic": _anthropic,
    "bedrock": _bedrock,
    "gemini": _gemini,
}


def run_smoke(provider: str, streaming: bool, meta: Dict[str, Any]):
    """Dispatch to a provider's smoke runner. Returns (message_id|None, usage|None)."""
    fn = SMOKE_PROVIDERS.get(provider)
    if fn is None:
        die(f'Unknown provider "{provider}". Known: {", ".join(SMOKE_PROVIDERS)}.')
    return fn(streaming, meta)
