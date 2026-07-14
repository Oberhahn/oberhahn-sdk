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
