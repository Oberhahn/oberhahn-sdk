#!/usr/bin/env python3
"""Live smoke test for `oberhahn` against a DEPLOYED OBERHAHN endpoint.

Makes ONE real, non-streaming provider call (OpenAI / Anthropic / Bedrock),
lets the SDK post the usage event to OBERHAHN, then reads it back to confirm it
landed and that the attribution round-tripped.

    Required:
      OBERHAHN_BASE_URL   deployed API root incl. /v0
      OBERHAHN_API_KEY    an oak_ key for that deployment
      one provider credential: OPENAI_API_KEY | ANTHROPIC_API_KEY | AWS creds

    Optional:
      OPENAI_MODEL        default "gpt-4o-mini"
      ANTHROPIC_MODEL     default "claude-haiku-4-5"
      BEDROCK_MODEL_ID    default "anthropic.claude-3-5-haiku-20241022-v1:0"

    Run:  cd python && python scripts/smoke.py
"""

from __future__ import annotations

import json
import os
import random
import time

from _smoke_common import (
    choose_provider,
    die,
    load_env_file,
    make_smoke_metadata,
    metadata_mismatches,
    read_back,
    run_smoke,
)

load_env_file()

import oberhahn  # noqa: E402  (after path/env setup)

BASE = os.environ.get("OBERHAHN_BASE_URL")
KEY = os.environ.get("OBERHAHN_API_KEY")
if not BASE:
    die("OBERHAHN_BASE_URL is not set (deployed API root incl. /v0).")
if not KEY:
    die("OBERHAHN_API_KEY is not set (an oak_ key for the deployment).")

SMOKE_ID = f"smoke_{int(time.time())}_{random.randint(0, 1_000_000)}"
META = make_smoke_metadata(SMOKE_ID)

print("OBERHAHN smoke test")
print(f"  endpoint : {BASE}")
print(f"  key      : {KEY[:8]}…")
print(f"  smoke_id : {SMOKE_ID}")

oberhahn_client = oberhahn.init(
    api_key=KEY,
    base_url=BASE,
    throw_on_error=False,
    on_error=lambda err: print("  submit error:", err),
)


def main() -> None:
    provider = choose_provider()

    print("\n→ making real provider call…")
    message_id, usage = run_smoke(provider, streaming=False, meta=META)
    print(f"  provider returned id={message_id}")
    print(f"  usage: {usage}")

    print("\n→ waiting for the event POST to complete…")
    oberhahn_client.await_pending()

    print("\n→ reading the event back from OBERHAHN…")
    rows = read_back(BASE, KEY, SMOKE_ID)
    if rows is None:
        return  # readback not permitted; not a failure of ingest
    if not rows:
        die("event NOT found on readback — check the endpoint, key scope, and logs.")
    print(f"\n✓ event landed. matched {len(rows)} row(s):")
    print(json.dumps(rows[0], indent=2, default=str))

    miss = metadata_mismatches(rows[0], META)
    if miss:
        die("metadata did NOT round-trip:\n    - " + "\n    - ".join(miss))
    print(f"\n✓ all {len(META)} attribution fields round-tripped.")


if __name__ == "__main__":
    main()
