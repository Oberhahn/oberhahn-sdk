"""Patch every usage-bearing method an adapter declares, in place, and return
the same client. Idempotent: re-wrapping (or double-wrapping) is a no-op, so
events are never double-emitted.

Handles both sync and async provider clients (the wrapped call returns whatever
the original returns — a value, a coroutine, or a stream), and tees streamed
results so the caller sees every chunk unchanged while usage is collected.
"""

from __future__ import annotations

import inspect
import warnings
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._client import OberhahnClient
from ._event import build_event
from ._metadata import route_metadata
from ._types import Adapter, MethodSpec

#: Marker so a client (and each patched method) is only wrapped once.
_WRAPPED = "_oberhahn_wrapped"


@dataclass
class _Ctx:
    ob: OberhahnClient
    adapter_name: str
    client_metadata: Optional[Dict[str, Any]]
    per_call: Dict[str, Any]
    kwargs: Dict[str, Any]
    spec: MethodSpec


def patch_client(
    client: Any,
    adapter: Adapter,
    ob: OberhahnClient,
    metadata: Optional[Dict[str, Any]] = None,
) -> Any:
    if getattr(client, _WRAPPED, False):
        return client
    patched = 0
    for spec in adapter.methods:
        if _patch_method(client, spec, ob, adapter.name, metadata):
            patched += 1
    if patched == 0:
        paths = ", ".join(spec.path for spec in adapter.methods)
        warnings.warn(
            f"[oberhahn] wrap(): none of the {adapter.name} methods ({paths}) were "
            f"found on the client — nothing patched. Is this a {adapter.name} client?",
            stacklevel=2,
        )
    try:
        setattr(client, _WRAPPED, True)
    except Exception:  # noqa: BLE001 — some clients forbid new attributes
        pass
    return client


def _patch_method(
    client: Any,
    spec: MethodSpec,
    ob: OberhahnClient,
    adapter_name: str,
    client_metadata: Optional[Dict[str, Any]],
) -> bool:
    """Patch one method in place. Returns ``True`` if it existed and was wrapped."""
    *parents, key = spec.path.split(".")
    owner: Any = client
    for part in parents:
        owner = getattr(owner, part, None)
        if owner is None:
            return False  # method not present
    original = getattr(owner, key, None)
    if not callable(original):
        return False
    if getattr(original, _WRAPPED, False):
        return True

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        cleaned_kwargs, per_call = _strip_ob_metadata(kwargs)
        is_stream = spec.is_stream(cleaned_kwargs) if spec.is_stream else False
        ctx = _Ctx(ob, adapter_name, client_metadata, per_call, cleaned_kwargs, spec)
        result = original(*args, **cleaned_kwargs)
        if inspect.isawaitable(result):
            return _async_finish(result, is_stream, ctx)
        return _finish(result, is_stream, ctx)

    wrapped._oberhahn_wrapped = True  # type: ignore[attr-defined]
    try:
        setattr(owner, key, wrapped)
    except Exception:  # noqa: BLE001
        return False
    return True


def _strip_ob_metadata(kwargs: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Pull ``ob_metadata`` / ``obMetadata`` out of the call kwargs so they are
    never forwarded to the provider. Returns ``(cleaned_kwargs, per_call)``.
    """
    if "ob_metadata" not in kwargs and "obMetadata" not in kwargs:
        return kwargs, {}
    cleaned = dict(kwargs)
    snake = cleaned.pop("ob_metadata", None)
    camel = cleaned.pop("obMetadata", None)
    per_call: Dict[str, Any] = {}
    if isinstance(snake, dict):
        per_call.update(snake)
    if isinstance(camel, dict):
        per_call.update(camel)
    return cleaned, per_call


def _finish(result: Any, is_stream: bool, ctx: _Ctx) -> Any:
    try:
        if is_stream and ctx.spec.extract_stream:
            return _tee_stream(result, ctx)
        _emit(ctx.spec.extract(result, ctx.kwargs) if ctx.spec.extract else None, ctx)
    except Exception:  # noqa: BLE001 — attribution must not break the request path
        if ctx.ob.throw_on_error:
            raise
    return result


async def _async_finish(awaitable: Any, is_stream: bool, ctx: _Ctx) -> Any:
    result = await awaitable
    return _finish(result, is_stream, ctx)


def _emit(usage: Any, ctx: _Ctx) -> None:
    if usage is None:
        return
    routed = route_metadata(ctx.ob.metadata, ctx.client_metadata, ctx.per_call)
    ctx.ob.submit(build_event(usage, routed, ctx.adapter_name))


def _make_on_done(ctx: _Ctx) -> Callable[[List[Any]], None]:
    def on_done(chunks: List[Any]) -> None:
        try:
            usage = ctx.spec.extract_stream(chunks, ctx.kwargs) if ctx.spec.extract_stream else None
            _emit(usage, ctx)
        except Exception:  # noqa: BLE001
            if ctx.ob.throw_on_error:
                raise

    return on_done


# ---------------------------------------------------------------------------
# Streaming tee. Yield every chunk to the caller unchanged while collecting
# them, then extract usage once the stream is fully consumed. Handles both
# directly-iterable results (OpenAI/Anthropic) and results whose iterable lives
# on ``.stream`` / ``["stream"]`` (Bedrock ConverseStream).
# ---------------------------------------------------------------------------

_NON_STREAM_ITERABLES = (dict, list, tuple, set, frozenset, str, bytes, bytearray)


def _is_sync_iterable(value: Any) -> bool:
    return hasattr(value, "__iter__") and not isinstance(value, _NON_STREAM_ITERABLES)


def _is_async_iterable(value: Any) -> bool:
    return hasattr(value, "__aiter__")


def _tee_stream(result: Any, ctx: _Ctx) -> Any:
    on_done = _make_on_done(ctx)
    if _is_async_iterable(result):
        return _TeeAsync(result, on_done)
    if _is_sync_iterable(result):
        return _TeeSync(result, on_done)

    nested = result.get("stream") if isinstance(result, dict) else getattr(result, "stream", None)
    if nested is not None:
        if _is_async_iterable(nested):
            _set_stream(result, _TeeAsync(nested, on_done))
            return result
        if _is_sync_iterable(nested):
            _set_stream(result, _TeeSync(nested, on_done))
            return result

    # Not iterable after all — best effort with no chunks.
    _emit(ctx.spec.extract_stream([], ctx.kwargs) if ctx.spec.extract_stream else None, ctx)
    return result


def _set_stream(result: Any, value: Any) -> None:
    try:
        if isinstance(result, dict):
            result["stream"] = value
        else:
            result.stream = value
    except Exception:  # noqa: BLE001 — frozen/immutable result; nothing safe to do
        pass


class _TeeSync:
    """Proxy a sync iterable: forward attribute access to the wrapped object but
    tee iteration, emitting usage when the stream is exhausted or closed.
    """

    def __init__(self, inner: Any, on_done: Callable[[List[Any]], None]) -> None:
        self._inner = inner
        self._on_done = on_done
        self._chunks: List[Any] = []
        self._finished = False

    def __iter__(self) -> Any:
        try:
            for chunk in self._inner:
                self._chunks.append(chunk)
                yield chunk
        finally:
            self._done()

    def _done(self) -> None:
        if self._finished:
            return
        self._finished = True
        self._on_done(self._chunks)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def __enter__(self) -> "_TeeSync":
        self._inner.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._inner.__exit__(*exc)


class _TeeAsync:
    """Async counterpart of :class:`_TeeSync`."""

    def __init__(self, inner: Any, on_done: Callable[[List[Any]], None]) -> None:
        self._inner = inner
        self._on_done = on_done
        self._chunks: List[Any] = []
        self._finished = False

    async def __aiter__(self) -> Any:
        try:
            async for chunk in self._inner:
                self._chunks.append(chunk)
                yield chunk
        finally:
            self._done()

    def _done(self) -> None:
        if self._finished:
            return
        self._finished = True
        self._on_done(self._chunks)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def __aenter__(self) -> "_TeeAsync":
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)
