"""Merge global + per-call attribution and route each key: known keys map to
canonical top-level event fields; everything else lands in ``custom`` (coerced
to strings, since OBERHAHN's ``custom`` is a string→string map).
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

#: Per-call/global key → canonical event field. Aliases mirror the server.
KNOWN: Dict[str, str] = {
    "session_id": "provider_session_id",
    "provider_session_id": "provider_session_id",
    "task_id": "task_id",
    "consumer_id": "consumer_id",
    "consumer_type": "consumer_type",
}


def _to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return None


def route_metadata(*sources: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge sources in ascending precedence (later wins), then route.

    Typical order: ``[init.metadata, wrap.metadata, ob_metadata]``. Returns a
    dict with the canonical top-level keys that are present plus a ``custom``
    string→string map (always present, possibly empty).
    """
    merged: Dict[str, Any] = {}
    for src in sources:
        if src:
            merged.update(src)

    routed: Dict[str, Any] = {"custom": {}}
    for key, value in merged.items():
        if value is None:
            continue
        as_str = _to_str(value)
        if as_str is None:
            continue
        known = KNOWN.get(key)
        if known:
            routed[known] = as_str
        else:
            routed["custom"][key] = as_str
    return routed
