"""Anthropic adapter — wiring tests against hand-built client fakes."""

from __future__ import annotations

from typing import Any, Callable, Dict

from helpers import init_capturing

import oberhahn


class _Messages:
    def __init__(self, handler: Callable[[Dict[str, Any]], Any]) -> None:
        self._handler = handler

    def create(self, **kwargs: Any) -> Any:
        return self._handler(kwargs)


def fake_anthropic(handler: Callable[[Dict[str, Any]], Any]) -> Any:
    class _Client:
        pass

    client = _Client()
    client.messages = _Messages(handler)
    return client


def test_extracts_message_usage_and_posts_event():
    client, calls = init_capturing()
    anthropic = oberhahn.wrap(
        fake_anthropic(
            lambda _b: {
                "id": "msg_1",
                "model": "claude-3-5-sonnet",
                "usage": {
                    "input_tokens": 1200,
                    "output_tokens": 300,
                    "cache_creation_input_tokens": 40,
                    "cache_read_input_tokens": 10,
                },
            }
        ),
        {"provider": "anthropic"},
    )

    res = anthropic.messages.create(model="claude-3-5-sonnet", messages=[])
    client.await_pending()

    assert res["id"] == "msg_1"
    assert len(calls) == 1
    assert calls[0].body["source"] == "sdk_oberhahn"
    assert calls[0].body["provider_message_id"] == "msg_1"
    assert calls[0].body["spend_details"] == {
        "model_provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "input_tokens": 1200,  # Anthropic's input_tokens is cache-exclusive
        "output_tokens": 300,
        "cache_write_tokens": 40,
        "cache_read_tokens": 10,
        "cached_tokens": 50,  # sum of the split
    }


def test_null_cache_counts_are_dropped():
    client, calls = init_capturing()
    anthropic = oberhahn.wrap(
        fake_anthropic(
            lambda _b: {
                "id": "m",
                "model": "x",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_creation_input_tokens": None,
                    "cache_read_input_tokens": None,
                },
            }
        ),
        {"provider": "anthropic"},
    )

    anthropic.messages.create(model="x")
    client.await_pending()

    spend = calls[0].body["spend_details"]
    assert "cache_write_tokens" not in spend
    assert "cache_read_tokens" not in spend
    assert spend["cached_tokens"] == 0


def test_captures_streamed_usage():
    def handler(_body: Dict[str, Any]) -> Any:
        def gen():
            yield {
                "type": "message_start",
                "message": {"id": "msg_s", "model": "claude-3-5-sonnet", "usage": {"input_tokens": 55}},
            }
            yield {"type": "content_block_delta", "delta": {"text": "hi"}}
            yield {"type": "message_delta", "usage": {"output_tokens": 120}}

        return gen()

    client, calls = init_capturing()
    anthropic = oberhahn.wrap(fake_anthropic(handler), {"provider": "anthropic"})

    stream = anthropic.messages.create(model="claude-3-5-sonnet", stream=True)
    seen = [chunk for chunk in stream]
    client.await_pending()

    assert len(seen) == 3
    assert len(calls) == 1
    assert calls[0].body["provider_message_id"] == "msg_s"
    assert calls[0].body["spend_details"]["input_tokens"] == 55
    assert calls[0].body["spend_details"]["output_tokens"] == 120


def test_idempotent_double_wrap():
    client, calls = init_capturing()
    base = fake_anthropic(
        lambda _b: {"id": "x", "model": "claude", "usage": {"input_tokens": 1, "output_tokens": 1}}
    )
    once = oberhahn.wrap(base, {"provider": "anthropic"})
    twice = oberhahn.wrap(once, {"provider": "anthropic"})

    assert twice is once
    once.messages.create(model="claude")
    client.await_pending()
    assert len(calls) == 1
