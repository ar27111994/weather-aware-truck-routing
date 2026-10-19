"""Per-request observability state: the request id and the timings of upstream calls.

Both live in :mod:`contextvars` so provider adapters can report without knowing about Django, and so
the access log written by the middleware can include them. Nothing recorded here ever holds a client
address, a query string, a request body or a secret.
"""

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Final

REQUEST_ID_UNSET: Final = "-"
"""Request id reported by log records emitted outside of a request (management commands, tests)."""

_request_id: ContextVar[str] = ContextVar("haulcast_request_id", default=REQUEST_ID_UNSET)
_upstream_calls: ContextVar[list["UpstreamCall"] | None] = ContextVar(
    "haulcast_upstream_calls", default=None
)
_cache_outcomes: ContextVar[list[str] | None] = ContextVar("haulcast_cache_outcomes", default=None)


@dataclass(frozen=True, slots=True)
class UpstreamCall:
    """One finished outbound HTTP exchange: who was called, how it ended and how long it took."""

    provider: str
    outcome: str
    elapsed_ms: float


def set_request_id(request_id: str) -> Token[str]:
    """Bind ``request_id`` to the current context; pass the token to :func:`reset_request_id`."""
    return _request_id.set(request_id)


def reset_request_id(token: Token[str]) -> None:
    """Restore the request id that was bound before the matching :func:`set_request_id`."""
    _request_id.reset(token)


def current_request_id() -> str:
    """Return the request id bound to the current context, or :data:`REQUEST_ID_UNSET`."""
    return _request_id.get()


def begin_request_metrics() -> tuple[Token[list[UpstreamCall] | None], Token[list[str] | None]]:
    """Start collecting upstream timings and cache outcomes for the current request."""
    return _upstream_calls.set([]), _cache_outcomes.set([])


def end_request_metrics(
    tokens: tuple[Token[list[UpstreamCall] | None], Token[list[str] | None]],
) -> tuple[tuple[UpstreamCall, ...], tuple[str, ...]]:
    """Stop collecting and return ``(upstream calls, cache outcomes)`` gathered since the start."""
    calls = _upstream_calls.get() or []
    outcomes = _cache_outcomes.get() or []
    _upstream_calls.reset(tokens[0])
    _cache_outcomes.reset(tokens[1])
    return tuple(calls), tuple(outcomes)


def record_upstream_call(provider: str, outcome: str, elapsed_ms: float) -> None:
    """Record a finished upstream exchange; a no-op outside of a request."""
    calls = _upstream_calls.get()
    if calls is not None:
        calls.append(UpstreamCall(provider=provider, outcome=outcome, elapsed_ms=elapsed_ms))


def record_cache_outcome(outcome: str) -> None:
    """Record ``hit`` or ``miss`` for one cache lookup; a no-op outside of a request."""
    outcomes = _cache_outcomes.get()
    if outcomes is not None:
        outcomes.append(outcome)
