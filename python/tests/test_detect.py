"""Provider auto-detection (``wrap(client)`` without a provider slug)."""

from __future__ import annotations

import pytest

from oberhahn._detect import detect_provider


class _Nested:
    """Build an object with nested attributes from a dotted spec, leaves callable."""

    def __init__(self, **attrs):
        for name, value in attrs.items():
            setattr(self, name, value)


def _openai():
    return _Nested(chat=_Nested(completions=_Nested(create=lambda: None)))


def _anthropic():
    return _Nested(messages=_Nested(create=lambda: None))


def _gemini():
    return _Nested(models=_Nested(generate_content=lambda: None))


def _bedrock():
    # boto3's bedrock-runtime client exposes converse().
    return _Nested(converse=lambda: None)


def test_detects_each_provider_by_api_surface() -> None:
    assert detect_provider(_openai()) == "openai"
    assert detect_provider(_anthropic()) == "anthropic"
    assert detect_provider(_gemini()) == "gemini"
    assert detect_provider(_bedrock()) == "bedrock"


def test_detects_openai_via_responses_surface() -> None:
    assert detect_provider(_Nested(responses=_Nested(create=lambda: None))) == "openai"


def test_folds_openai_compatible_to_openai() -> None:
    compat = _Nested(chat=_Nested(completions=_Nested(create=lambda: None)))
    compat.base_url = "https://openrouter.ai/api/v1"
    assert detect_provider(compat) == "openai"


def test_unrecognized_client_raises() -> None:
    with pytest.raises(ValueError, match="couldn't detect the provider"):
        detect_provider(_Nested(foo=lambda: None))
