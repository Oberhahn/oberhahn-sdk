"""OpenAI adapter — chat completions, responses, and embeddings."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._types import Adapter, MethodSpec, ProviderUsage
from .._util import coalesce, get
from ._normalize import strip_model_date

PROVIDER = "openai"


def _usage_from(result: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Build usage from any object/dict carrying a ``usage`` block + model + id."""
    usage_block = get(result, "usage")
    if usage_block is None:
        return None

    input_total = coalesce(get(usage_block, "prompt_tokens"), get(usage_block, "input_tokens"))
    output = coalesce(get(usage_block, "completion_tokens"), get(usage_block, "output_tokens"))
    cache_read = get(usage_block, "prompt_tokens_details", "cached_tokens")
    if cache_read is None:
        cache_read = get(usage_block, "input_tokens_details", "cached_tokens")

    model = strip_model_date(get(result, "model") or kwargs.get("model") or "unknown")
    # OpenAI's prompt_tokens/input_tokens is the TOTAL prompt and already
    # includes the *_tokens_details.cached_tokens subset. Report only the
    # non-cached remainder as input_tokens so the server (which prices
    # input_tokens at the input rate AND cache_read_tokens at the cache-read
    # rate) doesn't bill the cached tokens twice. (Anthropic's input_tokens is
    # cache-exclusive, so its adapter needs no subtraction.)
    usage = ProviderUsage(
        model=model,
        model_provider=PROVIDER,
        input_tokens=max(0, input_total - (cache_read or 0)),
        output_tokens=output,
    )
    if cache_read is not None:
        usage.cache_read_tokens = cache_read
    # OpenAI-compatible gateways (e.g. OpenRouter) can report a real cost in the
    # usage block; forward it when present so the server uses it instead of
    # deriving from tokens. Plain OpenAI omits it → stays None.
    cost = get(usage_block, "cost")
    if cost is not None:
        usage.cost = cost
    message_id = get(result, "id")
    if message_id:
        usage.provider_message_id = message_id
    return usage


def _usage_from_stream(chunks: List[Any], kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Streaming: the final chunk carries ``usage`` when ``include_usage`` is set."""
    usage_chunk = next((c for c in reversed(chunks) if get(c, "usage") is not None), None)
    if usage_chunk is None:
        return None
    first = chunks[0] if chunks else None
    synthetic = {
        "usage": get(usage_chunk, "usage"),
        "model": get(usage_chunk, "model") or get(first, "model"),
        "id": get(first, "id"),
    }
    return _usage_from(synthetic, kwargs)


def _is_stream(kwargs: Dict[str, Any]) -> bool:
    return kwargs.get("stream") is True


openai_adapter = Adapter(
    name=PROVIDER,
    methods=[
        MethodSpec(
            path="chat.completions.create",
            is_stream=_is_stream,
            extract=_usage_from,
            extract_stream=_usage_from_stream,
        ),
        MethodSpec(
            path="responses.create",
            is_stream=_is_stream,
            extract=_usage_from,
            extract_stream=_usage_from_stream,
        ),
        MethodSpec(
            path="embeddings.create",
            extract=_usage_from,
        ),
    ],
)
