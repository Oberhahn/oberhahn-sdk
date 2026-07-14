"""Global + per-client configuration and how it's resolved (args → env → default)."""

from __future__ import annotations

import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from ._version import __version__

_USER_AGENT = f"oberhahn-python/{__version__}"

#: A transport posts one event. Given ``(url, headers, body)`` it returns the
#: HTTP status code. It should raise on a transport/network failure (so the
#: client can retry); a non-2xx *response* is reported via the returned code.
Transport = Callable[[str, Dict[str, str], bytes], int]

OnError = Callable[[BaseException], None]

#: Hosted OBERHAHN ingest endpoint (incl. the /v0 suffix). Overridable via the
#: `base_url` arg or OBERHAHN_BASE_URL — set it for self-hosted / staging.
DEFAULT_BASE_URL = "https://app.oberhahn.com/v0"


def _default_transport(url: str, headers: Dict[str, str], body: bytes) -> int:
    # Send an explicit User-Agent. urllib's default ("Python-urllib/x.y") is
    # rejected (403) by common WAFs/CDNs like Cloudflare; identifying the SDK
    # both fixes that and makes traffic attributable. Caller headers win.
    merged = {"User-Agent": _USER_AGENT, **headers}
    req = urllib.request.Request(url, data=body, headers=merged, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (trusted URL)
            return resp.status
    except urllib.error.HTTPError as err:
        # A real HTTP response with a non-2xx status — hand the code back so the
        # retry logic can decide, rather than treating it as a transport failure.
        return err.code
    # urllib.error.URLError (DNS/connection) propagates → treated as retryable.


@dataclass
class ResolvedConfig:
    api_key: Optional[str]
    base_url: Optional[str]
    metadata: Dict[str, Any]
    throw_on_error: bool
    enabled: bool
    max_retries: int
    transport: Transport
    on_error: Optional[OnError]


def _env(name: str) -> Optional[str]:
    value = os.environ.get(name)
    return value if value else None


def _env_disabled() -> bool:
    value = os.environ.get("OBERHAHN_SDK_DISABLED")
    return value not in (None, "", "0") and (value or "").lower() != "false"


def resolve_config(
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    throw_on_error: bool = False,
    enabled: Optional[bool] = None,
    max_retries: int = 2,
    transport: Optional[Transport] = None,
    on_error: Optional[OnError] = None,
) -> ResolvedConfig:
    resolved_enabled = False if enabled is False else not _env_disabled()
    return ResolvedConfig(
        api_key=api_key or _env("OBERHAHN_API_KEY"),
        base_url=base_url or _env("OBERHAHN_BASE_URL") or DEFAULT_BASE_URL,
        metadata=metadata or {},
        throw_on_error=throw_on_error,
        enabled=resolved_enabled,
        max_retries=max_retries,
        transport=transport or _default_transport,
        on_error=on_error,
    )
