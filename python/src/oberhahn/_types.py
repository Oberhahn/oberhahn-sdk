"""The adapter contract — the SDK's single extension point.

Adding a provider is one file: implement the pieces of ``Adapter`` (a ``name``
plus a list of ``MethodSpec``), then register it in ``_registry.py`` under its
provider slug. The caller selects it explicitly via ``wrap(client, "<name>")``,
so there is no structural detection to maintain — the ``methods`` list alone
drives which functions get monkey-patched.

Design rule (see the spec): an adapter only *extracts* ``{model,
model_provider, tokens, ids}``. It never prices anything — the OBERHAHN server
derives cost from the token counts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Tuple


@dataclass
class ProviderUsage:
    """Canonical usage an adapter pulls out of a provider result."""

    #: Provider model id, e.g. "gpt-4o", "claude-3-5-sonnet".
    model: str
    #: Canonical provider slug, e.g. "openai" | "anthropic".
    model_provider: str
    input_tokens: int
    output_tokens: int
    #: Cache-creation tokens, when the provider reports the split.
    cache_write_tokens: Optional[int] = None
    #: Cache-read tokens, when the provider reports the split.
    cache_read_tokens: Optional[int] = None
    #: Provider's own message/response id, when present.
    provider_message_id: Optional[str] = None


#: ``(result, kwargs) -> ProviderUsage | None``. Pull usage from a resolved
#: non-stream result. ``None`` → don't emit.
Extract = Callable[[Any, dict], Optional[ProviderUsage]]

#: ``(chunks, kwargs) -> ProviderUsage | None``. Pull usage from the collected
#: chunks of a streamed call. Only invoked when ``is_stream(kwargs)`` is true.
ExtractStream = Callable[[List[Any], dict], Optional[ProviderUsage]]

#: ``(kwargs) -> bool``. Given the (ob_metadata-stripped) call kwargs, is this a
#: streaming call?
IsStream = Callable[[dict], bool]

#: ``(kwargs) -> (model_provider, model) | None``. Resolve provider + model from
#: the call kwargs alone (no result), for emitting an *error* event when the
#: provider call raises. Return ``None`` to skip emitting for this call.
ModelInfo = Callable[[dict], "Optional[Tuple[str, str]]"]


@dataclass
class MethodSpec:
    """One method to monkey-patch, and how to read usage back out of it."""

    #: Dotted method path on the client, e.g. "chat.completions.create".
    path: str
    #: Pull usage from a resolved non-stream result.
    extract: Extract
    #: Given the call kwargs, is this a streaming call?
    is_stream: Optional[IsStream] = None
    #: Pull usage from the collected chunks of a streamed call. Required for any
    #: method that can stream.
    extract_stream: Optional[ExtractStream] = None
    #: Resolve (provider, model) from kwargs for error events. Defaults to
    #: ``(adapter.name, kwargs["model"])`` when not set.
    model_info: Optional[ModelInfo] = None


@dataclass
class Adapter:
    """A provider adapter: a slug plus the methods it instruments."""

    #: Canonical provider slug, also used in the event ``source`` (``sdk_<name>``).
    name: str
    methods: List[MethodSpec] = field(default_factory=list)
