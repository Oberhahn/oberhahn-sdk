"""The provider matrix: slug → adapter.

The caller names the provider on ``wrap(client, {"provider": "<slug>"})``; we look the adapter
up here and patch the methods it declares. No structural detection, no ordering,
no ambiguity.
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional

from ._types import Adapter
from .adapters import anthropic_adapter, bedrock_adapter, gemini_adapter, openai_adapter

#: OpenAI-wire-compatible providers: their clients ARE the OpenAI SDK pointed at a
#: different ``base_url``, so they use the OpenAI adapter to read usage. Passing
#: one of these as ``provider`` tags the event with ``custom.provider="<slug>"``
#: (the routing layer) while ``model_provider`` stays what the adapter reports —
#: exactly like Bedrock records its hosting layer. Auto-detection can't tell them
#: apart from OpenAI, so they must be named explicitly:
#: ``wrap(client, {"provider": "openrouter"})``.
OPENAI_COMPATIBLE_PROVIDERS = (
    "openrouter",
    "together",
    "fireworks",
    "groq",
    "deepinfra",
    "perplexity",
    "xai",
    "deepseek",
    "mistral",
    "azure",
)

# The provider slugs `wrap()` accepts. Native adapters are auto-detectable;
# the OpenAI-compatible slugs above must be passed explicitly. Add a member when
# you register an adapter so type checkers flag typos.
Provider = Literal[
    "openai",
    "anthropic",
    "bedrock",
    "gemini",
    "openrouter",
    "together",
    "fireworks",
    "groq",
    "deepinfra",
    "perplexity",
    "xai",
    "deepseek",
    "mistral",
    "azure",
]

# scaffold:imports  (scripts/new_adapter.py inserts new adapter imports above this line)

ADAPTERS: Dict[str, Adapter] = {
    openai_adapter.name: openai_adapter,
    anthropic_adapter.name: anthropic_adapter,
    bedrock_adapter.name: bedrock_adapter,
    gemini_adapter.name: gemini_adapter,
    # scaffold:entries  (scripts/new_adapter.py inserts new adapter entries above this line)
}


def adapter_for(provider: str) -> Optional[Adapter]:
    """Adapter for a provider slug, or ``None`` if the slug is unknown.
    OpenAI-compatible slugs resolve to the OpenAI adapter."""
    adapter = ADAPTERS.get(provider)
    if adapter is not None:
        return adapter
    if provider in OPENAI_COMPATIBLE_PROVIDERS:
        return openai_adapter
    return None


def known_providers() -> List[str]:
    """Known provider slugs, for error messages and discovery."""
    return list(ADAPTERS.keys()) + list(OPENAI_COMPATIBLE_PROVIDERS)
