"""Owns config + the immediate-submit path to ``POST {base_url}/events``.

Immediate mode (the only mode): every accepted event kicks off its POST right
away on a background worker thread (serverless-safe — nothing sits buffered
waiting for a drain). Submission is fire-and-forget from the caller's
perspective; attribution never blocks or breaks the wrapped request unless
``throw_on_error`` is set.
"""

from __future__ import annotations

import threading
import time
import warnings
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Dict, Optional, Set

from ._config import ResolvedConfig

RETRYABLE = frozenset({408, 429, 500, 502, 503, 504})


def _backoff_seconds(attempt: int) -> float:
    # 0.1s, 0.2s, 0.4s, … (deterministic; no jitter dependency).
    return 0.1 * (2 ** attempt)


class OberhahnClient:
    def __init__(self, config: ResolvedConfig) -> None:
        self._config = config
        self._in_flight: Set["Future[None]"] = set()
        self._lock = threading.Lock()
        self._executor: Optional[ThreadPoolExecutor] = None
        self._warned_misconfigured = False

    @property
    def metadata(self) -> Dict[str, Any]:
        return self._config.metadata

    @property
    def throw_on_error(self) -> bool:
        return self._config.throw_on_error

    def _ensure_executor(self) -> ThreadPoolExecutor:
        with self._lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="oberhahn"
                )
            return self._executor

    def submit(self, event: Dict[str, Any]) -> None:
        """Enqueue (and immediately begin sending) one event."""
        if not self._config.enabled:
            return
        if not self._config.api_key or not self._config.base_url:
            if not self._warned_misconfigured:
                self._warned_misconfigured = True
                warnings.warn(
                    "[oberhahn] api_key/base_url not configured — events are being "
                    "dropped. Call init(api_key=..., base_url=...) or set "
                    "OBERHAHN_API_KEY / OBERHAHN_BASE_URL.",
                    stacklevel=2,
                )
            return

        future = self._ensure_executor().submit(self._post, event)
        with self._lock:
            self._in_flight.add(future)
        future.add_done_callback(self._on_done)

    def _on_done(self, future: "Future[None]") -> None:
        with self._lock:
            self._in_flight.discard(future)
        if self._config.throw_on_error:
            return  # leave the exception on the future for await_pending() to see
        exc = future.exception()
        if exc is not None and self._config.on_error is not None:
            self._config.on_error(exc)

    def flush(self) -> None:
        """Block until all in-flight submissions finish. Never raises.

        Submission is otherwise fire-and-forget: on a long-lived server or a
        normal script you don't need this (the interpreter joins the worker
        threads on exit). Call it in short-lived / serverless contexts (e.g. an
        AWS Lambda handler) to drain before the runtime freezes or reaps the
        process, so the last events aren't lost.
        """
        with self._lock:
            futures = list(self._in_flight)
        for future in futures:
            try:
                future.result()
            except Exception:  # noqa: BLE001 — draining, swallow everything
                pass

    #: Internal alias kept for tests / graceful-shutdown call sites.
    def await_pending(self) -> None:
        self.flush()

    def _post(self, event: Dict[str, Any]) -> None:
        import json

        url = self._config.base_url.rstrip("/") + "/events"  # type: ignore[union-attr]
        body = json.dumps(event).encode("utf-8")
        headers = {
            "authorization": f"Bearer {self._config.api_key}",
            "content-type": "application/json",
        }
        attempt = 0
        while True:
            try:
                status = self._config.transport(url, headers, body)
            except Exception:  # noqa: BLE001 — transport/network failure
                if attempt < self._config.max_retries:
                    time.sleep(_backoff_seconds(attempt))
                    attempt += 1
                    continue
                raise
            if 200 <= status < 300:
                return
            if status in RETRYABLE and attempt < self._config.max_retries:
                time.sleep(_backoff_seconds(attempt))
                attempt += 1
                continue
            raise RuntimeError(f"[oberhahn] ingest failed: {status}")
