"""Small shared helpers used across adapters."""

from __future__ import annotations

from typing import Any


def get(obj: Any, *keys: str) -> Any:
    """Walk a nested path on ``obj``, reading each key as either a mapping item
    or an attribute. Works uniformly on provider SDK objects (pydantic models,
    boto3 dicts) and the plain dicts/objects used in tests. Returns ``None`` as
    soon as any step is missing.
    """
    cur = obj
    for key in keys:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            cur = getattr(cur, key, None)
    return cur


def coalesce(*values: Any, default: int = 0) -> int:
    """First non-``None`` value, else ``default`` (mirrors JS ``a ?? b ?? 0``)."""
    for value in values:
        if value is not None:
            return value
    return default
