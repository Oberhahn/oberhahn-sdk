"""Provider adapters. Each is a one-file implementation of the ``Adapter``
contract; register a new one in ``.._registry``.
"""

from __future__ import annotations

from .anthropic import anthropic_adapter
from .bedrock import bedrock_adapter, map_bedrock_model
from .gemini import gemini_adapter
from .openai import openai_adapter

__all__ = [
    "openai_adapter",
    "anthropic_adapter",
    "bedrock_adapter",
    "map_bedrock_model",
    "gemini_adapter",
]
