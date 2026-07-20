"""Anthropic adapter — the Messages API."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._types import Adapter, MethodSpec, ProviderUsage
from .._util import coalesce, get
from ._normalize import strip_model_date

PROVIDER = "anthropic"


def _is_int(value: Any) -> bool:
    # The real SDK reports cache counts as ``int | None``; only carry a real
    # count (and never a stray bool, which is an int subclass in Python).
    return isinstance(value, int) and not isinstance(value, bool)


def _from_message(msg: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    usage_block = get(msg, "usage")
    if usage_block is None:
        return None
    model = strip_model_date(get(msg, "model") or kwargs.get("model") or "unknown")
    usage = ProviderUsage(
        model=model,
        model_provider=PROVIDER,
        input_tokens=coalesce(get(usage_block, "input_tokens")),
        output_tokens=coalesce(get(usage_block, "output_tokens")),
    )
    cache_write = get(usage_block, "cache_creation_input_tokens")
    if _is_int(cache_write):
        usage.cache_write_tokens = cache_write
    cache_read = get(usage_block, "cache_read_input_tokens")
    if _is_int(cache_read):
        usage.cache_read_tokens = cache_read
    message_id = get(msg, "id")
    if message_id:
        usage.provider_message_id = message_id
    return usage


def _from_stream(chunks: List[Any], kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Streaming usage is split across events: ``message_start`` carries input +
    cache tokens, ``message_delta`` carries the running output total.
    """
    message_id: Optional[str] = None
    model: Optional[str] = None
    merged: Dict[str, Any] = {}
    for event in chunks:
        event_type = get(event, "type")
        if event_type == "message_start":
            message = get(event, "message")
            if message is not None:
                message_id = get(message, "id")
                model = get(message, "model")
                usage = get(message, "usage")
                for key in (
                    "input_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                ):
                    value = get(usage, key)
                    if value is not None:
                        merged[key] = value
        elif event_type == "message_delta":
            usage = get(event, "usage")
            output = get(usage, "output_tokens")
            if output is not None:
                merged["output_tokens"] = output
    if message_id is None and model is None and not merged:
        return None
    return _from_message({"usage": merged, "model": model, "id": message_id}, kwargs)


def _is_stream(kwargs: Dict[str, Any]) -> bool:
    return kwargs.get("stream") is True


anthropic_adapter = Adapter(
    name=PROVIDER,
    methods=[
        MethodSpec(
            path="messages.create",
            is_stream=_is_stream,
            extract=_from_message,
            extract_stream=_from_stream,
        ),
    ],
)
