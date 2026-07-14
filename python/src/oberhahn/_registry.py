"""The provider matrix: slug → adapter.

The caller names the provider on ``wrap(client, "<slug>")``; we look the adapter
up here and patch the methods it declares. No structural detection, no ordering,
no ambiguity.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from ._types import Adapter
from .adapters import anthropic_adapter, bedrock_adapter, gemini_adapter, openai_adapter

# scaffold:imports  (scripts/new_adapter.py inserts new adapter imports above this line)

ADAPTERS: Dict[str, Adapter] = {
    openai_adapter.name: openai_adapter,
    anthropic_adapter.name: anthropic_adapter,
    bedrock_adapter.name: bedrock_adapter,
    gemini_adapter.name: gemini_adapter,
    # scaffold:entries  (scripts/new_adapter.py inserts new adapter entries above this line)
}


def adapter_for(provider: str) -> Optional[Adapter]:
    """Adapter for a provider slug, or ``None`` if the slug is unknown."""
    return ADAPTERS.get(provider)


def known_providers() -> List[str]:
    """Known provider slugs, for error messages and discovery."""
    return list(ADAPTERS.keys())
