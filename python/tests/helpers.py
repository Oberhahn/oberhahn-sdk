"""Test helpers: a capturing transport + an ``init()`` that uses it."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

import oberhahn
from oberhahn import OberhahnClient


class Captured:
    __slots__ = ("url", "body", "headers")

    def __init__(self, url: str, body: Dict[str, Any], headers: Dict[str, str]) -> None:
        self.url = url
        self.body = body
        self.headers = headers


def capture_transport() -> Tuple[Any, List[Captured]]:
    """A transport spy that records each POST and returns 202."""
    calls: List[Captured] = []

    def transport(url: str, headers: Dict[str, str], body: bytes) -> int:
        calls.append(Captured(url, json.loads(body.decode("utf-8")), dict(headers)))
        return 202

    return transport, calls


def init_capturing(**extra: Any) -> Tuple[OberhahnClient, List[Captured]]:
    """``init()`` the SDK with a capturing transport; return the client + calls."""
    transport, calls = capture_transport()
    config = {
        "api_key": "oak_test",
        "base_url": "https://oberhahn.test/v0",
        "transport": transport,
    }
    config.update(extra)
    client = oberhahn.init(**config)
    return client, calls
