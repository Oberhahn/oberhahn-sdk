"""The canonical payload POSTed to ``POST {base_url}/events``.

Intentionally a loose input shape: the OBERHAHN server fills
``organization_id``, ``consumer_id``, ``date``, and derives ``cost`` from the
token counts. The SDK never prices anything.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._types import ProviderUsage

DEFAULT_CONSUMER_TYPE = "customer"

#: A single, provider-independent ``source`` for every SDK-emitted event. 
EVENT_SOURCE = "sdk_oberhahn"


def build_event(
    usage: ProviderUsage,
    routed: Dict[str, Any],
    *,
    duration_ms: Optional[int] = None,
    status: str = "success",
) -> Dict[str, Any]:
    cache_write = usage.cache_write_tokens
    cache_read = usage.cache_read_tokens
    has_split = cache_write is not None or cache_read is not None
    # When the split is known the server prices it and ignores ``cached_tokens``;
    # set the total to the sum so a total-only consumer still sees it.
    cached_tokens = (cache_write or 0) + (cache_read or 0) if has_split else 0

    spend_details: Dict[str, Any] = {
        "model_provider": usage.model_provider,
        "model": usage.model,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cached_tokens": cached_tokens,
    }
    if cache_write is not None:
        spend_details["cache_write_tokens"] = cache_write
    if cache_read is not None:
        spend_details["cache_read_tokens"] = cache_read
    if usage.cost is not None:
        spend_details["cost"] = usage.cost

    event: Dict[str, Any] = {
        "source": EVENT_SOURCE,
        "consumer_type": routed.get("consumer_type") or DEFAULT_CONSUMER_TYPE,
        "spend_details": spend_details,
        "status": status,
    }
    if duration_ms is not None:
        event["duration_ms"] = duration_ms
    if routed.get("consumer_id"):
        event["consumer_id"] = routed["consumer_id"]
    if routed.get("task_id"):
        event["task_id"] = routed["task_id"]
    if routed.get("provider_session_id"):
        event["provider_session_id"] = routed["provider_session_id"]
    if usage.provider_message_id:
        event["provider_message_id"] = usage.provider_message_id
    # Adapter-derived custom tags (e.g. ``provider: "openrouter"``) sit *under*
    # user ``ob_metadata`` custom, so an explicit caller value always wins.
    custom = {**(usage.custom or {}), **(routed.get("custom") or {})}
    if custom:
        event["custom"] = custom
    return event
