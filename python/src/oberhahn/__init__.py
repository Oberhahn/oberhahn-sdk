"""``oberhahn`` — a thin, server-side SDK that wraps native provider SDKs,
extracts token usage + attribution from each call, and posts canonical events
to OBERHAHN's ``POST /v0/events``.

    import oberhahn
    from openai import OpenAI

    oberhahn.init(api_key="oak_...", base_url="https://oberhahn.example.com/v0")

    client = oberhahn.wrap(OpenAI(), "openai", metadata={"feature": "support_agent"})
    client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        ob_metadata={"customer_id": "cust_123", "session_id": session_id},
    )
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._client import OberhahnClient
from ._config import OnError, Transport, resolve_config
from ._registry import ADAPTERS, adapter_for, known_providers
from ._types import Adapter, MethodSpec, ProviderUsage
from ._version import __version__
from ._wrap import patch_client

__all__ = [
    "init",
    "wrap",
    "flush",
    "OberhahnClient",
    "Adapter",
    "MethodSpec",
    "ProviderUsage",
    "Transport",
]

_global_client: Optional[OberhahnClient] = None


def init(
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    throw_on_error: bool = False,
    enabled: Optional[bool] = None,
    max_retries: int = 2,
    transport: Optional[Transport] = None,
    on_error: Optional[OnError] = None,
) -> OberhahnClient:
    """Set global config (also read from env). Safe to call once at process
    start. Returns the client that owns the outbound queue.
    """
    global _global_client
    _global_client = OberhahnClient(
        resolve_config(
            api_key=api_key,
            base_url=base_url,
            metadata=metadata,
            throw_on_error=throw_on_error,
            enabled=enabled,
            max_retries=max_retries,
            transport=transport,
            on_error=on_error,
        )
    )
    return _global_client


def _ensure_client() -> OberhahnClient:
    global _global_client
    if _global_client is None:
        _global_client = OberhahnClient(resolve_config())
    return _global_client


def wrap(
    client: Any,
    provider: str,
    *,
    metadata: Optional[Dict[str, Any]] = None,
) -> Any:
    """Wrap a provider ``client`` for the named ``provider`` (``"openai"`` |
    ``"anthropic"`` | ``"bedrock"`` | ``"gemini"``): look the adapter up in the registry,
    monkey-patch the usage-bearing methods it declares, and return the same
    client (mutated in place). Idempotent — re-wrapping never double-emits.
    Raises on an unknown provider; warns (and no-ops) if the client carries none
    of that provider's methods.
    """
    adapter = adapter_for(provider)
    if adapter is None:
        raise ValueError(
            f'[oberhahn] wrap(): unknown provider "{provider}". '
            f"Known providers: {', '.join(known_providers())}."
        )
    return patch_client(client, adapter, _ensure_client(), metadata)


def flush() -> None:
    """Block until every event submitted so far has finished posting.

    Submission is fire-and-forget, so this is a no-op you never need on a
    long-lived server or a normal script (the interpreter drains the worker
    threads on exit). Call it in short-lived / serverless contexts — e.g. at the
    end of an AWS Lambda handler — to drain before the runtime freezes or reaps
    the process, so the last events aren't lost. Never raises.
    """
    if _global_client is not None:
        _global_client.flush()
