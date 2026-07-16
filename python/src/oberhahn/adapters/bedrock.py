"""AWS Bedrock adapter — boto3's Converse API (``converse`` / ``converse_stream``).

Unlike the JS AWS SDK's ``send(Command)`` pattern, boto3 exposes Converse as
plain methods taking keyword args (``modelId=...``) and returning dicts, so the
streaming vs non-streaming split is simply which method was called — no command
introspection, and ``ob_metadata`` is an ordinary kwarg like every other adapter.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .._types import Adapter, MethodSpec, ProviderUsage
from .._util import coalesce, get

PROVIDER = "bedrock"
#: Bedrock is a hosting layer: ``model_provider`` is the real model vendor
#: (anthropic/amazon/meta/…), and ``custom.provider`` records that AWS Bedrock
#: routed/billed the call.
HOSTING = "bedrock"

_REGION_PREFIX = re.compile(r"^(us|eu|apac|us-gov)\.")
_VERSION_SUFFIX = re.compile(r"-v\d+:\d+$")
_COLON_SUFFIX = re.compile(r":\d+$")
_DATE_SUFFIX = re.compile(r"-\d{8}$")


def map_bedrock_model(model_id: str) -> Dict[str, str]:
    """Map a Bedrock model id to a canonical ``{provider, model}`` so it prices
    on OBERHAHN's existing table. Strips the optional region prefix (``us.``,
    ``eu.``, ``apac.``, ``us-gov.``) and the trailing version/date suffixes.

        "us.anthropic.claude-3-5-sonnet-20240620-v1:0"
          → {"provider": "anthropic", "model": "claude-3-5-sonnet"}
    """
    without_region = _REGION_PREFIX.sub("", model_id)
    dot = without_region.find(".")
    # The vendor prefix (anthropic./amazon./meta./…) is the real model vendor.
    provider = without_region[:dot] if dot >= 0 else HOSTING
    model = without_region[dot + 1:] if dot >= 0 else without_region
    model = _VERSION_SUFFIX.sub("", model)
    model = _COLON_SUFFIX.sub("", model)
    model = _DATE_SUFFIX.sub("", model)
    return {"provider": provider, "model": model}


def _to_usage(usage_block: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    if usage_block is None:
        return None
    mapped = map_bedrock_model(kwargs.get("modelId") or "")
    usage = ProviderUsage(
        model=mapped["model"] or "unknown",
        model_provider=mapped["provider"],
        input_tokens=coalesce(get(usage_block, "inputTokens")),
        output_tokens=coalesce(get(usage_block, "outputTokens")),
        custom={"provider": HOSTING},
    )
    cache_write = get(usage_block, "cacheWriteInputTokens")
    if cache_write is not None:
        usage.cache_write_tokens = cache_write
    cache_read = get(usage_block, "cacheReadInputTokens")
    if cache_read is not None:
        usage.cache_read_tokens = cache_read
    return usage


def _extract(result: Any, kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    return _to_usage(get(result, "usage"), kwargs)


def _extract_stream(chunks: List[Any], kwargs: Dict[str, Any]) -> Optional[ProviderUsage]:
    for chunk in chunks:
        usage_block = get(chunk, "metadata", "usage")
        if usage_block is not None:
            return _to_usage(usage_block, kwargs)
    return None


def _model_info(kwargs: Dict[str, Any]):
    """Provider + model from the request kwargs alone, for error events."""
    mapped = map_bedrock_model(kwargs.get("modelId") or "")
    return (mapped["provider"], mapped["model"] or "unknown")


bedrock_adapter = Adapter(
    name=PROVIDER,
    methods=[
        MethodSpec(path="converse", extract=_extract, model_info=_model_info),
        MethodSpec(
            path="converse_stream",
            is_stream=lambda _kwargs: True,
            extract=_extract,  # never called (always a stream); present for symmetry
            extract_stream=_extract_stream,
            model_info=_model_info,
        ),
    ],
)
