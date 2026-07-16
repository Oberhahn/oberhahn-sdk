"""Gemini adapter — wiring tests against a google-genai-shaped client fake."""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

import pytest
from helpers import init_capturing

import oberhahn


class _Models:
    def __init__(
        self,
        generate: Callable[[Dict[str, Any]], Any],
        stream: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ) -> None:
        self._generate = generate
        self._stream = stream or generate

    def generate_content(self, **kwargs: Any) -> Any:
        return self._generate(kwargs)

    def generate_content_stream(self, **kwargs: Any) -> Any:
        return self._stream(kwargs)


def fake_gemini(
    generate: Optional[Callable[[Dict[str, Any]], Any]] = None,
    stream: Optional[Callable[[Dict[str, Any]], Any]] = None,
) -> Any:
    default_generate = lambda _b: {
        "response_id": "resp_1",
        "model_version": "gemini-2.0-flash",
        "usage_metadata": {
            "prompt_token_count": 1200,
            "candidates_token_count": 300,
            "cached_content_token_count": 200,
            "total_token_count": 1500,
        },
    }

    class _Client:
        pass

    client = _Client()
    client.models = _Models(generate or default_generate, stream)
    return client


def test_extracts_generate_content_and_posts_event():
    client, calls = init_capturing()
    gemini = oberhahn.wrap(fake_gemini(), "gemini")

    res = gemini.models.generate_content(model="gemini-2.0-flash", contents="hi")
    client.await_pending()

    assert res["response_id"] == "resp_1"  # caller still gets the result
    assert len(calls) == 1
    assert calls[0].body["source"] == "sdk_gemini"
    assert calls[0].body["provider_message_id"] == "resp_1"
    assert calls[0].body["spend_details"] == {
        "model_provider": "google",
        "model": "gemini-2.0-flash",
        # prompt_token_count (1200) already includes the 200 cached tokens, so the
        # adapter reports the 1000 non-cached remainder as input_tokens.
        "input_tokens": 1000,
        "output_tokens": 300,
        "cache_read_tokens": 200,
        "cached_tokens": 200,
    }


def test_generate_content_without_cache_omits_split():
    def generate(_b: Dict[str, Any]) -> Any:
        return {
            "response_id": "resp_2",
            "model_version": "gemini-2.0-flash",
            "usage_metadata": {"prompt_token_count": 40, "candidates_token_count": 12},
        }

    client, calls = init_capturing()
    gemini = oberhahn.wrap(fake_gemini(generate=generate), "gemini")

    gemini.models.generate_content(model="gemini-2.0-flash", contents="hi")
    client.await_pending()

    body = calls[0].body["spend_details"]
    assert body["input_tokens"] == 40
    assert body["output_tokens"] == 12
    # No cached subset reported → the split field must be absent, not 0/null.
    assert "cache_read_tokens" not in body


def test_routes_ob_metadata_off_kwargs():
    seen: Dict[str, Any] = {}

    def generate(kwargs: Dict[str, Any]) -> Any:
        seen.update(kwargs)
        return {
            "response_id": "r3",
            "model_version": "gemini-2.0-flash",
            "usage_metadata": {"prompt_token_count": 5, "candidates_token_count": 2},
        }

    client, calls = init_capturing()
    gemini = oberhahn.wrap(fake_gemini(generate=generate), "gemini")

    gemini.models.generate_content(
        model="gemini-2.0-flash",
        contents="hi",
        ob_metadata={"customer_id": "cust_9", "session_id": "conv_1"},
    )
    client.await_pending()

    assert "ob_metadata" not in seen  # stripped before the provider call
    assert calls[0].body["provider_session_id"] == "conv_1"
    assert calls[0].body["custom"] == {"customer_id": "cust_9"}


def test_reads_usage_from_generate_content_stream():
    def stream(_kwargs: Dict[str, Any]) -> Any:
        def gen():
            yield {"model_version": "gemini-2.0-flash", "candidates": [{"content": {"parts": [{"text": "hi"}]}}]}
            yield {
                "response_id": "s1",
                "model_version": "gemini-2.0-flash",
                "usage_metadata": {
                    "prompt_token_count": 10,
                    "candidates_token_count": 5,
                    "cached_content_token_count": 4,
                },
            }

        return gen()

    client, calls = init_capturing()
    gemini = oberhahn.wrap(fake_gemini(stream=stream), "gemini")

    res = gemini.models.generate_content_stream(model="gemini-2.0-flash", contents="hi")
    seen = [chunk for chunk in res]
    client.await_pending()

    assert len(seen) == 2  # caller still receives every chunk
    assert len(calls) == 1
    assert calls[0].body["spend_details"] == {
        "model_provider": "google",
        "model": "gemini-2.0-flash",
        "input_tokens": 6,  # 10 total − 4 cached
        "output_tokens": 5,
        "cache_read_tokens": 4,
        "cached_tokens": 4,
    }


def test_failed_generate_content_emits_error_event():
    def boom(_k):
        raise RuntimeError("gemini down")

    client, calls = init_capturing()
    gemini = oberhahn.wrap(fake_gemini(generate=boom), "gemini")

    with pytest.raises(RuntimeError, match="gemini down"):
        gemini.models.generate_content(model="gemini-2.0-flash", contents="hi")
    client.await_pending()

    assert len(calls) == 1
    assert calls[0].body["status"] == "error"
    assert calls[0].body["spend_details"]["model"] == "gemini-2.0-flash"
    assert calls[0].body["spend_details"]["model_provider"] == "google"
    assert calls[0].body["spend_details"]["input_tokens"] == 0
