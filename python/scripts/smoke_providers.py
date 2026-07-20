"""Provider smoke runners — ONE entry per provider covers every smoke mode
(non-stream, stream, interactive, all). Adding a provider = one entry here, not
a runner in each mode. Each returns (provider_message_id | None, usage | None);
streaming returns (None, None) — usage is extracted from the stream by the SDK
and confirmed on read-back. `oberhahn.wrap()` uses the global client the calling
script init()'d. Mirrors js/scripts/smoke-providers.mjs.

Everything comes from env vars — no secrets in code. These make a real (tiny,
cheap) API call and write a real event to the DEPLOYED endpoint, so run them
deliberately.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict

# Make the local package importable without an install (mirrors `npm run smoke`
# building dist/ first — here we just add src/ to the path).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "src"))


def die(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    sys.stderr.write(f"\n✗ {msg}\n\n")
    sys.exit(1)


_PROMPT = "Give me a 200 word paragraph."


def _openai(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from openai import OpenAI

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = oberhahn.wrap(OpenAI())  # provider auto-detected
    print(f"  provider : openai ({model}{', streaming' if streaming else ''})")
    args = dict(model=model, max_tokens=100, messages=[{"role": "user", "content": _PROMPT}], ob_metadata=meta)
    if streaming:
        stream = client.chat.completions.create(**args, stream=True, stream_options={"include_usage": True})
        print(f"  consumed {sum(1 for _ in stream)} chunk(s)")
        return None, None
    res = client.chat.completions.create(**args)
    return res.id, res.usage


def _anthropic(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from anthropic import Anthropic

    model = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
    client = oberhahn.wrap(Anthropic())  # provider auto-detected
    print(f"  provider : anthropic ({model}{', streaming' if streaming else ''})")
    args = dict(model=model, max_tokens=100, messages=[{"role": "user", "content": _PROMPT}], ob_metadata=meta)
    if streaming:
        stream = client.messages.create(**args, stream=True)
        print(f"  consumed {sum(1 for _ in stream)} event(s)")
        return None, None
    res = client.messages.create(**args)
    return res.id, res.usage


def _bedrock(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        die("Set AWS_REGION for the Bedrock smoke (plus AWS credentials).")
    model_id = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-5-haiku-20241022-v1:0")
    client = oberhahn.wrap(boto3.client("bedrock-runtime", region_name=region))  # provider auto-detected
    print(f"  provider : bedrock ({model_id}, {region}{', streaming' if streaming else ''})")
    args = dict(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": _PROMPT}]}],
        inferenceConfig={"maxTokens": 16},
        ob_metadata=meta,
    )
    if streaming:
        res = client.converse_stream(**args)
        print(f"  consumed {sum(1 for _ in res['stream'])} event(s)")
        return None, None
    res = client.converse(**args)
    return None, res.get("usage")


def _gemini(streaming: bool, meta: Dict[str, Any]):
    import oberhahn
    from google import genai

    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    client = oberhahn.wrap(genai.Client())  # provider auto-detected
    print(f"  provider : gemini ({model}{', streaming' if streaming else ''})")
    if streaming:
        stream = client.models.generate_content_stream(model=model, contents=_PROMPT, ob_metadata=meta)
        print(f"  consumed {sum(1 for _ in stream)} chunk(s)")
        return None, None
    res = client.models.generate_content(model=model, contents=_PROMPT, ob_metadata=meta)
    return getattr(res, "response_id", None), res.usage_metadata


def _openrouter(streaming: bool, meta: Dict[str, Any]):
    # OpenRouter is OpenAI-wire-compatible: the OpenAI client pointed at
    # OpenRouter's base_url, wrapped with an explicit provider so the event is
    # tagged custom.provider="openrouter" (model_provider stays "openai").
    import oberhahn
    from openai import OpenAI

    if not os.environ.get("OPENROUTER_API_KEY"):
        die("Set OPENROUTER_API_KEY for the OpenRouter smoke.")
    base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    client = oberhahn.wrap(
        OpenAI(base_url=base_url, api_key=os.environ["OPENROUTER_API_KEY"]),
        {"provider": "openrouter"},
    )
    print(f"  provider : openrouter ({model} @ {base_url}{', streaming' if streaming else ''})")
    # extra_body usage.include asks OpenRouter to report cost in the usage block,
    # which the OpenAI adapter forwards to spend_details.cost.
    args = dict(
        model=model,
        max_tokens=100,
        messages=[{"role": "user", "content": _PROMPT}],
        extra_body={"usage": {"include": True}},
        ob_metadata=meta,
    )
    if streaming:
        stream = client.chat.completions.create(**args, stream=True, stream_options={"include_usage": True})
        print(f"  consumed {sum(1 for _ in stream)} chunk(s)")
        return None, None
    res = client.chat.completions.create(**args)
    return res.id, res.usage


SMOKE_PROVIDERS = {
    "openai": _openai,
    "anthropic": _anthropic,
    "bedrock": _bedrock,
    "gemini": _gemini,
    "openrouter": _openrouter,
}


def choose_provider() -> str:
    forced = os.environ.get("OBERHAHN_SMOKE_PROVIDER")
    if forced:
        return forced
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE") or os.environ.get("AWS_BEARER_TOKEN_BEDROCK") or os.environ.get("AWS_REGION"):
        return "bedrock"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("OPENROUTER_API_KEY"):
        return "openrouter"
    die(
        "No provider selected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS creds, "
        "GEMINI_API_KEY, or OPENROUTER_API_KEY (or force with "
        "OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock|gemini|openrouter)."
    )


def run_smoke(provider: str, streaming: bool, meta: Dict[str, Any]):
    """Dispatch to a provider's smoke runner. Returns (message_id|None, usage|None)."""
    fn = SMOKE_PROVIDERS.get(provider)
    if fn is None:
        die(f'Unknown provider "{provider}". Known: {", ".join(SMOKE_PROVIDERS)}.')
    return fn(streaming, meta)
