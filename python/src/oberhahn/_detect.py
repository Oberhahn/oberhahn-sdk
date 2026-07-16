"""Best-effort provider detection so ``wrap(client)`` can be called without
naming the provider.

We duck-type on the API surface each adapter patches (rather than class names).
If nothing matches we raise, asking the caller to pass ``provider`` — detection
never returns a wrong guess.

OpenAI-compatible clients (Azure, OpenRouter-via-``openai``, gateways) all share
the OpenAI surface, so they resolve to ``"openai"``; pass ``provider`` to select
a different adapter for those.
"""

from __future__ import annotations

from typing import Any

from ._registry import Provider


def _has_callable(obj: Any, *path: str) -> bool:
    """True if ``obj.<path...>`` exists and is callable."""
    for name in path:
        obj = getattr(obj, name, None)
        if obj is None:
            return False
    return callable(obj)


def detect_provider(client: Any) -> Provider:
    """Detect the provider for ``client``, or raise telling the caller to pass
    ``provider``. Never returns an unsure guess."""
    if _has_callable(client, "messages", "create"):
        return "anthropic"
    if _has_callable(client, "models", "generate_content"):
        return "gemini"
    if (
        _has_callable(client, "chat", "completions", "create")
        or _has_callable(client, "responses", "create")
        or _has_callable(client, "embeddings", "create")
    ):
        return "openai"
    # boto3's bedrock-runtime client exposes converse()/converse_stream().
    if _has_callable(client, "converse"):
        return "bedrock"
    raise ValueError(
        "[oberhahn] wrap(): couldn't detect the provider from this client. "
        'Pass it explicitly, e.g. wrap(client, "openai").'
    )
