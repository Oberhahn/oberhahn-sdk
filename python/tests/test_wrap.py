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
from oberhahn._event import build_event
from oberhahn._metadata import route_metadata
from oberhahn._types import ProviderUsage


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


def test_build_event_forwards_provider_reported_cost_when_present():
    usage = ProviderUsage(model="gpt-4o", model_provider="openai", input_tokens=10, output_tokens=4, cost=0.42)
    event = build_event(usage, {"consumer_type": "customer"}, "openai")

    assert event["spend_details"]["cost"] == 0.42


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


def test_success_event_has_status_and_duration():
    client, calls = init_capturing()
    openai = oberhahn.wrap(
        fake_openai(lambda _b: {"id": "x", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
        "openai",
    )
    openai.chat.completions.create(model="gpt-4o")
    client.await_pending()
    assert calls[0].body["status"] == "success"
    assert isinstance(calls[0].body["duration_ms"], int)
    assert calls[0].body["duration_ms"] >= 0


def test_failed_call_emits_error_event_and_reraises():
    def boom(_b):
        raise RuntimeError("provider down")

    client, calls = init_capturing()
    openai = oberhahn.wrap(fake_openai(boom), "openai")

    with pytest.raises(RuntimeError, match="provider down"):
        openai.chat.completions.create(model="gpt-4o")
    client.await_pending()

    assert len(calls) == 1
    body = calls[0].body
    assert body["status"] == "error"
    assert isinstance(body["duration_ms"], int)
    assert body["spend_details"] == {
        "model_provider": "openai",
        "model": "gpt-4o",  # resolved from kwargs, since there's no result
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_tokens": 0,
    }


def test_error_reporting_failure_never_masks_original_exception(monkeypatch):
    # Even if event submission blows up, the caller must see THEIR error.
    client, _calls = init_capturing()
    openai = oberhahn.wrap(
        fake_openai(lambda _b: (_ for _ in ()).throw(RuntimeError("provider down"))),
        "openai",
    )
    monkeypatch.setattr(client, "submit", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("submit boom")))
    with pytest.raises(RuntimeError, match="provider down"):
        openai.chat.completions.create(model="gpt-4o")


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
