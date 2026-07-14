"""Google Gemini adapter — the ``google-genai`` SDK's ``generate_content`` API.

Like Bedrock's Converse, Gemini exposes streaming as a *separate method*
(``models.generate_content_stream``) rather than a ``stream=True`` kwarg, so the
streaming vs non-streaming split is simply which method was called.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._types import Adapter, MethodSpec, ProviderUsage
from .._util import coalesce, get

PROVIDER = "gemini"


def _usage_from(result: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Build usage from a ``GenerateContentResponse`` (or the synthetic dict the
    stream path assembles). Returns ``None`` when there is no usage block."""
    usage_block = get(result, "usage_metadata")
    if usage_block is None:
        return None

    input_total = coalesce(get(usage_block, "prompt_token_count"))
    output = coalesce(get(usage_block, "candidates_token_count"))
    cache_read = get(usage_block, "cached_content_token_count")

    model = get(result, "model_version") or kwargs.get("model") or "unknown"
    # Gemini's prompt_token_count is the TOTAL prompt and already includes the
    # cached_content_token_count subset (the cached part of the prompt). Report
    # only the non-cached remainder as input_tokens so the server (which prices
    # input_tokens at the input rate AND cache_read_tokens at the cache-read
    # rate) doesn't bill the cached tokens twice — same rule as OpenAI.
    #
    # candidates_token_count is the visible output; Gemini reports any thinking
    # tokens separately in thoughts_token_count, which we intentionally do not
    # fold in here (it maps to output_tokens 1:1, like every other adapter).
    usage = ProviderUsage(
        model=model,
        model_provider=PROVIDER,
        input_tokens=max(0, input_total - (cache_read or 0)),
        output_tokens=output,
    )
    if cache_read is not None:
        usage.cache_read_tokens = cache_read
    response_id = get(result, "response_id")
    if response_id:
        usage.provider_message_id = response_id
    return usage


def _usage_from_stream(chunks: List[Any], kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    """Streaming: each chunk is a ``GenerateContentResponse``; the final chunk
    carries the cumulative ``usage_metadata``, so read the last one that has it."""
    usage_chunk = next((c for c in reversed(chunks) if get(c, "usage_metadata") is not None), None)
    if usage_chunk is None:
        return None
    first = chunks[0] if chunks else None
    synthetic = {
        "usage_metadata": get(usage_chunk, "usage_metadata"),
        "model_version": get(usage_chunk, "model_version") or get(first, "model_version"),
        "response_id": get(usage_chunk, "response_id") or get(first, "response_id"),
    }
    return _usage_from(synthetic, kwargs)


def _model_info(kwargs: Dict[str, Any]):
    """Provider + model from the request kwargs alone, for error events."""
    return (PROVIDER, kwargs.get("model") or "unknown")


gemini_adapter = Adapter(
    name=PROVIDER,
    methods=[
        MethodSpec(
            path="models.generate_content",
            extract=_usage_from,
            model_info=_model_info,
        ),
        MethodSpec(
            path="models.generate_content_stream",
            is_stream=lambda _kwargs: True,
            extract=_usage_from,  # never called (always a stream); present for symmetry
            extract_stream=_usage_from_stream,
            model_info=_model_info,
        ),
    ],
)
