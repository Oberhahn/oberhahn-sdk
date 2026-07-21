#!/usr/bin/env python3
"""Scaffold a new provider adapter.

    python scripts/new_adapter.py <slug>

Writes a stubbed adapter (`src/oberhahn/adapters/<slug>.py`) + test
(`tests/test_<slug>.py`), and registers the adapter in `_registry.py` at the
`# scaffold:` anchors. After running, implement the two `extract` bodies and the
method `path`, then follow the printed checklist (dev pin, extra, contract canary).
"""

from __future__ import annotations

import os
import re
import sys

SLUG_RE = re.compile(r"^[a-z][a-z0-9_]*$")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # python/
SRC = os.path.join(ROOT, "src", "oberhahn")

ADAPTER_TEMPLATE = '''"""__SLUG__ adapter — TODO: describe which method(s) this instruments."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._types import Adapter, MethodSpec, ProviderUsage
from .._util import coalesce, get

PROVIDER = "__SLUG__"


def _extract(result: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Pull usage from a non-streaming result. Return None to skip emitting.

    `get(obj, *keys)` reads dict items OR attributes, so it works on both SDK
    response objects and plain dicts. TODO: map the real usage field names.
    """
    usage_block = get(result, "usage")
    if usage_block is None:
        return None
    model = get(result, "model") or kwargs.get("model") or "unknown"
    return ProviderUsage(
        model=model,
        model_provider=PROVIDER,
        input_tokens=coalesce(get(usage_block, "input_tokens")),    # TODO: real field
        output_tokens=coalesce(get(usage_block, "output_tokens")),  # TODO: real field
        # cache_read_tokens=..., cache_write_tokens=..., provider_message_id=...
    )


def _is_stream(kwargs: Dict[str, Any]) -> bool:
    return kwargs.get("stream") is True


def _extract_stream(chunks: List[Any], kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Usage from the collected chunks of a streamed call. TODO — or delete this
    (and is_stream/extract_stream below) if this method never streams."""
    return None


__SLUG___adapter = Adapter(
    name=PROVIDER,
    methods=[
        MethodSpec(
            path="TODO.method.path",          # dotted path to monkey-patch, e.g. "messages.create"
            extract=_extract,
            is_stream=_is_stream,              # remove if the method never streams
            extract_stream=_extract_stream,    # remove if the method never streams
            # model_info=lambda kwargs: (PROVIDER, kwargs.get("model") or "unknown"),
        ),
    ],
)
'''

TEST_TEMPLATE = '''"""__SLUG__ adapter — wiring test. TODO: build a fake matching the real shape."""

from __future__ import annotations

import pytest
from helpers import init_capturing

import oberhahn


@pytest.mark.skip(reason="TODO: implement the __SLUG__ adapter and this test")
def test___SLUG___extracts_usage_and_posts_event():
    client, calls = init_capturing()
    # TODO: fake a client whose method path returns a result with a usage block,
    # then assert calls[0].body["spend_details"] matches.
    _ = (client, calls, oberhahn)
'''


def _insert_before(text: str, anchor: str, line: str) -> str:
    if anchor not in text:
        sys.exit(f"anchor '{anchor}' not found in _registry.py — was it edited away?")
    return text.replace(anchor, line + anchor, 1)


def main() -> None:
    if len(sys.argv) != 2 or not SLUG_RE.match(sys.argv[1]):
        sys.exit("usage: python scripts/new_adapter.py <slug>   (lowercase, [a-z][a-z0-9_]*)")
    slug = sys.argv[1]

    adapter_path = os.path.join(SRC, "adapters", f"{slug}.py")
    test_path = os.path.join(ROOT, "tests", f"test_{slug}.py")
    registry_path = os.path.join(SRC, "_registry.py")

    if os.path.exists(adapter_path):
        sys.exit(f"adapter already exists: {adapter_path}")

    with open(adapter_path, "w", encoding="utf-8") as fh:
        fh.write(ADAPTER_TEMPLATE.replace("__SLUG__", slug))
    with open(test_path, "w", encoding="utf-8") as fh:
        fh.write(TEST_TEMPLATE.replace("__SLUG__", slug))

    with open(registry_path, encoding="utf-8") as fh:
        reg = fh.read()
    if f"from .adapters.{slug} import" not in reg:
        reg = _insert_before(reg, "# scaffold:imports", f"from .adapters.{slug} import {slug}_adapter\n")
        reg = _insert_before(reg, "    # scaffold:entries", f"    {slug}_adapter.name: {slug}_adapter,\n")
        with open(registry_path, "w", encoding="utf-8") as fh:
            fh.write(reg)

    print(f"✓ created src/oberhahn/adapters/{slug}.py")
    print(f"✓ created tests/test_{slug}.py")
    print(f"✓ registered {slug}_adapter in _registry.py")
    print("\nNext:")
    print(f"  1. Implement _extract (+ _extract_stream) and the MethodSpec.path in adapters/{slug}.py")
    print(f"  2. Un-skip and flesh out tests/test_{slug}.py")
    print(f"  3. Add the provider's PyPI package to requirements-dev.txt (pinned) and a")
    print(f"     [{slug}] extra in pyproject.toml (loose >=)")
    print(f"  4. Add a drift canary for it in tests/test_contract.py")
    print(f"  5. Do the same in the JS SDK: cd ../js && node scripts/new-adapter.mjs {slug}")


if __name__ == "__main__":
    main()
