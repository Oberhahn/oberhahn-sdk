"""Default transport: it must send an explicit User-Agent.

urllib's default ("Python-urllib/x.y") is rejected with 403 by common
WAFs/CDNs (e.g. Cloudflare in front of the OBERHAHN endpoint), so the default
transport sets an SDK User-Agent instead. Regression test for that.
"""

from __future__ import annotations

import urllib.request

from oberhahn._config import _USER_AGENT, _default_transport


class _FakeResponse:
    status = 202

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def test_default_transport_sends_sdk_user_agent(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["user_agent"] = req.get_header("User-agent")
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        return _FakeResponse()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    status = _default_transport(
        "https://oberhahn.test/v0/events",
        {"authorization": "Bearer oak_test", "content-type": "application/json"},
        b"{}",
    )

    assert status == 202
    assert captured["method"] == "POST"
    assert captured["user_agent"] == _USER_AGENT
    assert captured["user_agent"].startswith("oberhahn-python/")
    # It must NOT be urllib's default, which is what gets 403'd.
    assert "Python-urllib" not in captured["user_agent"]
