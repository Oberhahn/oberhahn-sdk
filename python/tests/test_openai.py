"""OpenAI adapter — wiring tests against hand-built client fakes."""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from helpers import init_capturing

import oberhahn


class _Completions:
    def __init__(self, handler: Callable[[Dict[str, Any]], Any]) -> None:
        self._handler = handler

    def create(self, **kwargs: Any) -> Any:
        return self._handler(kwargs)


class _Chat:
    def __init__(self, handler: Callable[[Dict[str, Any]], Any]) -> None:
        self.completions = _Completions(handler)


class _Resource:
    def __init__(self, handler: Callable[[Dict[str, Any]], Any]) -> None:
        self._handler = handler

    def create(self, **kwargs: Any) -> Any:
        return self._handler(kwargs)


def fake_openai(
    chat: Optional[Callable[[Dict[str, Any]], Any]] = None,
    responses: Optional[Callable[[Dict[str, Any]], Any]] = None,
    embeddings: Optional[Callable[[Dict[str, Any]], Any]] = None,
) -> Any:
    default_chat = lambda _b: {
        "id": "chatcmpl_1",
        "model": "gpt-4o",
        "usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 300,
            "prompt_tokens_details": {"cached_tokens": 200},
        },
    }
    default_responses = lambda _b: {
        "id": "resp_1",
        "model": "gpt-4o",
        "usage": {
            "input_tokens": 800,
            "output_tokens": 120,
            "input_tokens_details": {"cached_tokens": 300},
        },
    }
    default_embeddings = lambda _b: {
        "model": "text-embedding-3-small",
        "usage": {"prompt_tokens": 50, "total_tokens": 50},
    }

    class _Client:
        pass

    client = _Client()
    client.chat = _Chat(chat or default_chat)
    client.responses = _Resource(responses or default_responses)
    client.embeddings = _Resource(embeddings or default_embeddings)
    return client


def test_extracts_chat_completion_and_posts_event():
    client, calls = init_capturing()
    openai = oberhahn.wrap(fake_openai(), "openai")

    res = openai.chat.completions.create(model="gpt-4o", messages=[])
    client.await_pending()

    assert res["id"] == "chatcmpl_1"  # caller still gets the result
    assert len(calls) == 1
    assert calls[0].url == "https://oberhahn.test/v0/events"
    assert calls[0].headers["authorization"] == "Bearer oak_test"
    body = calls[0].body
    assert body["source"] == "sdk_oberhahn"
    assert body["consumer_type"] == "customer"
    assert body["provider_message_id"] == "chatcmpl_1"
    assert body["spend_details"] == {
        "model_provider": "openai",
        "model": "gpt-4o",
        # prompt_tokens (1200) already includes the 200 cached_tokens, so the
        # adapter reports the 1000 non-cached remainder as input_tokens.
        "input_tokens": 1000,
        "output_tokens": 300,
        "cache_read_tokens": 200,
        "cached_tokens": 200,
    }


def test_extracts_responses_create():
    client, calls = init_capturing()
    openai = oberhahn.wrap(fake_openai(), "openai")

    res = openai.responses.create(model="gpt-4o", input="hi")
    client.await_pending()

    assert res["id"] == "resp_1"
    assert len(calls) == 1
    assert calls[0].body["provider_message_id"] == "resp_1"
    assert calls[0].body["spend_details"] == {
        "model_provider": "openai",
        "model": "gpt-4o",
        "input_tokens": 500,  # 800 total − 300 cached
        "output_tokens": 120,
        "cache_read_tokens": 300,
        "cached_tokens": 300,
    }


def test_extracts_embeddings_no_cache_no_stream():
    client, calls = init_capturing()
    openai = oberhahn.wrap(fake_openai(), "openai")

    res = openai.embeddings.create(model="text-embedding-3-small", input="hi")
    client.await_pending()

    assert res["model"] == "text-embedding-3-small"
    assert len(calls) == 1
    assert calls[0].body["spend_details"]["model"] == "text-embedding-3-small"
    assert calls[0].body["spend_details"]["input_tokens"] == 50
    assert calls[0].body["spend_details"]["output_tokens"] == 0
    # No cached subset reported → the split field must be absent, not 0/null.
    assert "cache_read_tokens" not in calls[0].body["spend_details"]


def test_routes_ob_metadata_and_strips_it():
    seen: Dict[str, Any] = {}

    def chat(body: Dict[str, Any]) -> Any:
        seen.update(body)
        return {"id": "c2", "model": "gpt-4o", "usage": {"prompt_tokens": 1, "completion_tokens": 2}}

    client, calls = init_capturing()
    openai = oberhahn.wrap(
        fake_openai(chat=chat),
        "openai",
        metadata={"environment": "production", "feature": "support_agent"},
    )

    openai.chat.completions.create(
        model="gpt-4o",
        messages=[],
        ob_metadata={"customer_id": "cust_123", "session_id": "conv_9", "turn_id": "t1"},
    )
    client.await_pending()

    assert "ob_metadata" not in seen  # stripped before forwarding
    body = calls[0].body
    assert body["provider_session_id"] == "conv_9"
    assert body["custom"] == {
        "environment": "production",
        "feature": "support_agent",
        "customer_id": "cust_123",
        "turn_id": "t1",
    }


def test_captures_streamed_usage():
    def chat(_body: Dict[str, Any]) -> Any:
        def gen():
            yield {"id": "s1", "model": "gpt-4o", "choices": [{"delta": {"content": "hi"}}]}
            yield {"id": "s1", "model": "gpt-4o", "usage": {"prompt_tokens": 10, "completion_tokens": 5}}

        return gen()

    client, calls = init_capturing()
    openai = oberhahn.wrap(fake_openai(chat=chat), "openai")

    stream = openai.chat.completions.create(model="gpt-4o", stream=True)
    seen = [chunk for chunk in stream]
    client.await_pending()

    assert len(seen) == 2  # caller still receives every chunk
    assert len(calls) == 1
    assert calls[0].body["spend_details"]["input_tokens"] == 10
    assert calls[0].body["spend_details"]["output_tokens"] == 5
    assert calls[0].body["spend_details"]["model"] == "gpt-4o"
