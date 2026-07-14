"""Contract / drift tests against the REAL provider SDK response models.

The per-adapter suites use hand-built fakes to test wiring. This file imports
the installed provider SDKs' response *models* and asserts the exact fields each
adapter reads still exist — a Dependabot drift tripwire. If a bump renames or
removes a field (e.g. ``CompletionUsage.prompt_tokens``), the matching canary
fails, CI goes red, and the PR does not auto-merge.

Each block ``importorskip``s its provider SDK, so the file is a no-op until that
SDK is installed (it is in the ``dev`` extra, so CI runs all three).
"""

from __future__ import annotations

import pytest

from oberhahn.adapters.anthropic import _from_message
from oberhahn.adapters.bedrock import bedrock_adapter
from oberhahn.adapters.gemini import _usage_from as _gemini_usage_from
from oberhahn.adapters.openai import _usage_from


def _fields(model_cls) -> set:
    """Field names of a pydantic (v2 ``model_fields`` / v1 ``__fields__``) model."""
    fields = getattr(model_cls, "model_fields", None) or getattr(model_cls, "__fields__", {})
    return set(fields.keys())


def test_openai_usage_fields_present():
    types_mod = pytest.importorskip("openai.types")
    usage_fields = _fields(types_mod.CompletionUsage)
    assert {"prompt_tokens", "completion_tokens"} <= usage_fields
    assert "prompt_tokens_details" in usage_fields
    # And the adapter still reads a real-typed usage block.
    usage = types_mod.CompletionUsage(
        prompt_tokens=1200,
        completion_tokens=300,
        total_tokens=1500,
        prompt_tokens_details={"cached_tokens": 200},
    )
    result = {"id": "chatcmpl_1", "model": "gpt-4o", "usage": usage}
    out = _usage_from(result, {"model": "gpt-4o"})
    assert out is not None
    assert out.input_tokens == 1000  # 1200 − 200 cached
    assert out.output_tokens == 300
    assert out.cache_read_tokens == 200


def test_anthropic_usage_fields_present():
    anthropic_types = pytest.importorskip("anthropic.types")
    usage_fields = _fields(anthropic_types.Usage)
    assert {
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    } <= usage_fields
    usage = anthropic_types.Usage(
        input_tokens=1200,
        output_tokens=300,
        cache_creation_input_tokens=40,
        cache_read_input_tokens=10,
    )
    out = _from_message({"id": "msg_1", "model": "claude-3-5-sonnet", "usage": usage}, {})
    assert out is not None
    assert out.input_tokens == 1200
    assert out.cache_write_tokens == 40
    assert out.cache_read_tokens == 10


def test_gemini_usage_fields_present():
    genai_types = pytest.importorskip("google.genai.types")
    usage_fields = _fields(genai_types.GenerateContentResponseUsageMetadata)
    assert {
        "prompt_token_count",
        "candidates_token_count",
        "cached_content_token_count",
    } <= usage_fields
    response_fields = _fields(genai_types.GenerateContentResponse)
    assert {"usage_metadata", "response_id", "model_version"} <= response_fields
    # And the adapter still reads a real-typed usage block.
    usage = genai_types.GenerateContentResponseUsageMetadata(
        prompt_token_count=1200,
        candidates_token_count=300,
        cached_content_token_count=200,
        total_token_count=1500,
    )
    result = {"response_id": "resp_1", "model_version": "gemini-2.0-flash", "usage_metadata": usage}
    out = _gemini_usage_from(result, {"model": "gemini-2.0-flash"})
    assert out is not None
    assert out.input_tokens == 1000  # 1200 − 200 cached
    assert out.output_tokens == 300
    assert out.cache_read_tokens == 200


def test_bedrock_usage_shape_present():
    # boto3's Converse output is an untyped dict at runtime; assert the model
    # spec in botocore still names the token fields the adapter reads.
    botocore_session = pytest.importorskip("botocore.session")
    session = botocore_session.get_session()
    service_model = session.get_service_model("bedrock-runtime")
    token_usage = service_model.shape_for("TokenUsage")
    assert {"inputTokens", "outputTokens"} <= set(token_usage.members.keys())
    # And the adapter extracts from a Converse-shaped dict.
    out = bedrock_adapter.methods[0].extract(
        {"usage": {"inputTokens": 500, "outputTokens": 90}},
        {"modelId": "us.anthropic.claude-3-5-sonnet-20240620-v1:0"},
    )
    assert out is not None
    assert out.model == "claude-3-5-sonnet"
    assert out.model_provider == "anthropic"
    assert out.input_tokens == 500
