"""Bedrock adapter — wiring tests against a boto3-shaped client fake."""

from __future__ import annotations

from typing import Any, Callable, Dict

import pytest
from helpers import init_capturing

import oberhahn
from oberhahn.adapters import map_bedrock_model


def fake_bedrock(responder: Callable[[Dict[str, Any]], Any]) -> Any:
    class _Client:
        def converse(self, **kwargs: Any) -> Any:
            return responder(kwargs)

        def converse_stream(self, **kwargs: Any) -> Any:
            return responder(kwargs)

        def list_foundation_models(self, **kwargs: Any) -> Any:
            return {"modelSummaries": []}

    return _Client()


def test_maps_model_ids():
    assert map_bedrock_model("us.anthropic.claude-3-5-sonnet-20240620-v1:0") == {
        "provider": "anthropic",
        "model": "claude-3-5-sonnet",
    }
    assert map_bedrock_model("anthropic.claude-3-haiku-20240307-v1:0") == {
        "provider": "anthropic",
        "model": "claude-3-haiku",
    }


def test_extracts_converse_usage_and_maps_model():
    client, calls = init_capturing()
    bedrock = oberhahn.wrap(
        fake_bedrock(lambda _k: {"usage": {"inputTokens": 500, "outputTokens": 90}}),
        {"provider": "bedrock"},
    )

    bedrock.converse(modelId="us.anthropic.claude-3-5-sonnet-20240620-v1:0", messages=[])
    client.await_pending()

    assert calls[0].body["source"] == "sdk_oberhahn"
    assert calls[0].body["spend_details"] == {
        "model_provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "input_tokens": 500,
        "output_tokens": 90,
        "cached_tokens": 0,
    }


def test_unpatched_method_passes_through_no_event():
    client, calls = init_capturing()
    bedrock = oberhahn.wrap(
        fake_bedrock(lambda _k: {"usage": {"inputTokens": 1, "outputTokens": 1}}),
        {"provider": "bedrock"},
    )

    res = bedrock.list_foundation_models()
    client.await_pending()

    assert res["modelSummaries"] == []
    assert len(calls) == 0


def test_routes_ob_metadata_off_kwargs():
    seen: Dict[str, Any] = {}

    def responder(kwargs: Dict[str, Any]) -> Any:
        seen.update(kwargs)
        return {"usage": {"inputTokens": 3, "outputTokens": 1}}

    client, calls = init_capturing()
    bedrock = oberhahn.wrap(fake_bedrock(responder), {"provider": "bedrock"})

    bedrock.converse(
        modelId="anthropic.claude-3-haiku-20240307-v1:0",
        messages=[],
        ob_metadata={"customer_id": "cust_9", "session_id": "conv_1"},
    )
    client.await_pending()

    assert "ob_metadata" not in seen  # stripped before the provider call
    assert calls[0].body["provider_session_id"] == "conv_1"
    # Bedrock's hosting tag merges with the caller's custom metadata.
    assert calls[0].body["custom"] == {"provider": "bedrock", "customer_id": "cust_9"}
    assert calls[0].body["spend_details"]["model"] == "claude-3-haiku"


def test_failed_converse_emits_error_event_with_mapped_model():
    def boom(_k):
        raise RuntimeError("bedrock down")

    client, calls = init_capturing()
    bedrock = oberhahn.wrap(fake_bedrock(boom), {"provider": "bedrock"})

    with pytest.raises(RuntimeError, match="bedrock down"):
        bedrock.converse(modelId="us.anthropic.claude-3-5-sonnet-20240620-v1:0", messages=[])
    client.await_pending()

    assert len(calls) == 1
    assert calls[0].body["status"] == "error"
    assert calls[0].body["spend_details"]["model"] == "claude-3-5-sonnet"
    assert calls[0].body["spend_details"]["model_provider"] == "anthropic"
    assert calls[0].body["spend_details"]["input_tokens"] == 0


def test_reads_usage_from_converse_stream():
    def responder(_kwargs: Dict[str, Any]) -> Any:
        def gen():
            yield {"contentBlockDelta": {"delta": {"text": "hi"}}}
            yield {"metadata": {"usage": {"inputTokens": 12, "outputTokens": 4}}}

        return {"stream": gen()}

    client, calls = init_capturing()
    bedrock = oberhahn.wrap(responder and fake_bedrock(responder), {"provider": "bedrock"})

    res = bedrock.converse_stream(modelId="anthropic.claude-3-haiku-20240307-v1:0", messages=[])
    seen = [event for event in res["stream"]]
    client.await_pending()

    assert len(seen) == 2  # caller still receives every event
    assert len(calls) == 1
    assert calls[0].body["spend_details"] == {
        "model_provider": "anthropic",
        "model": "claude-3-haiku",
        "input_tokens": 12,
        "output_tokens": 4,
        "cached_tokens": 0,
    }
