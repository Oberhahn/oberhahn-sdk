"""Core wrap()/client behavior: metadata routing, idempotency, error handling,
retries, the kill switch, and async clients.
"""

from __future__ import annotations

import asyncio
import types
from typing import Any, Dict

import pytest
from helpers import capture_transport, init_capturing

import oberhahn
from oberhahn._metadata import route_metadata


def fake_openai(create):
    class _Completions:
        def create(self, **kwargs: Any) -> Any:
            return create(kwargs)

    class _Chat:
        completions = _Completions()

    class _Embeddings:
        def create(self, **kwargs: Any) -> Any:
            return {}

    class _Client:
        chat = _Chat()
        embeddings = _Embeddings()

    return _Client()


# --- metadata routing --------------------------------------------------------


def test_routes_known_keys_and_custom():
    routed = route_metadata(
        {"environment": "prod"},
        {"feature": "agent"},
        {"session_id": "s1", "task_id": "t1", "consumer_id": "c1", "consumer_type": "team", "turn_id": 7},
    )
    assert routed == {
        "provider_session_id": "s1",
        "task_id": "t1",
        "consumer_id": "c1",
        "consumer_type": "team",
        "custom": {"environment": "prod", "feature": "agent", "turn_id": "7"},
    }


def test_later_sources_win():
    routed = route_metadata({"feature": "a"}, {"feature": "b"}, {"feature": "c"})
    assert routed["custom"]["feature"] == "c"


# --- wrap() ------------------------------------------------------------------


def test_idempotent_double_wrap_does_not_double_emit():
    client, calls = init_capturing()
    base = fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
    once = oberhahn.wrap(base, "openai")
    twice = oberhahn.wrap(once, "openai")

    assert twice is once
    once.chat.completions.create(model="gpt-4o")
    client.await_pending()
    assert len(calls) == 1


def test_throws_on_unknown_provider():
    init_capturing()
    with pytest.raises(ValueError, match="unknown provider"):
        oberhahn.wrap(types.SimpleNamespace(chat=None), "not-a-provider")


def test_warns_and_returns_client_when_no_methods():
    init_capturing()
    weird = types.SimpleNamespace(do=lambda: 1)
    with pytest.warns(UserWarning, match="nothing patched"):
        result = oberhahn.wrap(weird, "openai")
    assert result is weird


# --- client behavior ---------------------------------------------------------


def test_never_throws_into_request_path_on_submit_failure():
    errors = []
    transport = lambda _u, _h, _b: 400  # noqa: E731
    client = oberhahn.init(
        api_key="oak_test",
        base_url="https://oberhahn.test/v0",
        transport=transport,
        on_error=errors.append,
    )
    openai = oberhahn.wrap(
        fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
        "openai",
    )

    # The wrapped call returns normally even though ingest 400s.
    res = openai.chat.completions.create(model="gpt-4o")
    assert res is not None
    client.await_pending()
    assert len(errors) == 1


def test_retries_retryable_ingest_failures():
    attempts = {"n": 0}

    def transport(_u, _h, _b):
        attempts["n"] += 1
        return 503 if attempts["n"] < 2 else 202

    client = oberhahn.init(
        api_key="oak_test",
        base_url="https://oberhahn.test/v0",
        max_retries=3,
        transport=transport,
    )
    openai = oberhahn.wrap(
        fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
        "openai",
    )

    openai.chat.completions.create(model="gpt-4o")
    client.await_pending()
    assert attempts["n"] == 2


def test_module_level_flush_drains_pending():
    _client, calls = init_capturing()
    openai = oberhahn.wrap(
        fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
        "openai",
    )

    openai.chat.completions.create(model="gpt-4o")
    oberhahn.flush()  # public drain, no handle on the client needed
    assert len(calls) == 1


def test_noop_passthrough_when_disabled():
    transport, calls = capture_transport()
    client = oberhahn.init(
        api_key="oak_test",
        base_url="https://oberhahn.test/v0",
        enabled=False,
        transport=transport,
    )
    openai = oberhahn.wrap(
        fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
        "openai",
    )

    res = openai.chat.completions.create(model="gpt-4o")
    client.await_pending()
    assert res["id"] == "x"
    assert len(calls) == 0


# --- async client ------------------------------------------------------------


def test_wraps_an_async_client():
    def build():
        class _Completions:
            async def create(self, **kwargs: Any) -> Any:
                return {"id": "a1", "model": "gpt-4o", "usage": {"prompt_tokens": 7, "completion_tokens": 3}}

        class _Chat:
            completions = _Completions()

        class _Client:
            chat = _Chat()

        return _Client()

    client, calls = init_capturing()
    openai = oberhahn.wrap(build(), "openai")

    async def run():
        res = await openai.chat.completions.create(model="gpt-4o")
        return res

    res = asyncio.run(run())
    client.await_pending()

    assert res["id"] == "a1"
    assert len(calls) == 1
    assert calls[0].body["spend_details"]["input_tokens"] == 7
    assert calls[0].body["spend_details"]["output_tokens"] == 3
