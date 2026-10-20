"""Global upstream budgets: refuse to call a rate-limited upstream *before* it refuses us.

Open-Meteo bills one call per location and limits its free tier per egress IP (600/min, 5,000/h,
10,000/day). Vercel instances share egress addresses, so a purely local counter cannot know how much
of the allowance is left. The budget lives in PostgreSQL (``app.upstream_budget_take``, the
same atomic GCRA function that rate-limits clients) at roughly 83% of the free limits, so
every instance draws from one shared pool and a spike degrades to a clean
``weather_capacity_exhausted`` 503 with a ``Retry-After`` instead of an upstream 429.

**What a window promises.** ``limit`` calls in *any* window of ``window_s`` seconds, never more.
A token bucket with a burst of ``b`` tokens refilling ``r`` tokens per window admits ``b + r``
calls in a window that starts when it is full, so a bucket whose burst equals its rate lets twice
its rate through (the review's probe P14: 19 of "10 per 2 s" in 1.97 s, which for Open-Meteo means
about 18,000 calls in a day against a 10,000 allowance). Every window therefore splits its limit
in two halves: ``burst = limit // 2`` is spent at once, ``rate = limit - burst`` refills over the
window, and ``burst + rate == limit`` holds exactly. The price is a sustained rate of half the
limit; the burst absorbs a demo-sized spike and the weather cache makes most calls free.

A take spans all windows of a budget (minute/hour/day) and is all-or-nothing: if any window
refuses, the tokens already taken from the others are given back. It is one short transaction of
a few statements: **never wrap a take, or anything that holds a lock, around an upstream call**.
Callers spend tokens *per attempt* through :meth:`UpstreamBudgetGuard.attempt_hook`, immediately
before the attempt is sent, and tokens are never refunded: an upstream that timed out may still
have counted the call.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from django.db import connection, transaction

from haulcast.providers.errors import UpstreamBudgetExhaustedError

_MS_PER_S: Final = 1000.0
_MIN_LIMIT: Final = 2
"""One token for the burst and one for the refill."""


@dataclass(frozen=True, slots=True)
class BudgetWindow:
    """At most ``limit`` upstream calls in any ``window_s`` seconds (see the module docs)."""

    name: str
    limit: int
    window_s: int

    def __post_init__(self) -> None:
        """Refuse a limit too small to split into a burst and a refill.

        Raises:
            ValueError: ``limit`` is below 2.
        """
        if self.limit < _MIN_LIMIT:
            raise ValueError("a budget window needs a limit of at least 2 (a burst and a refill)")

    @property
    def burst(self) -> int:
        """Tokens that may be spent at once: the bucket's depth (half the limit, rounded down)."""
        return self.limit // 2

    @property
    def rate(self) -> int:
        """Tokens that refill over one window: what the burst leaves of the limit."""
        return self.limit - self.burst


@dataclass(frozen=True, slots=True)
class Budget:
    """A named upstream allowance made of one or more windows."""

    name: str
    windows: tuple[BudgetWindow, ...]


OPEN_METEO: Final = Budget(
    "openmeteo",
    (
        BudgetWindow("minute", 500, 60),
        BudgetWindow("hour", 4_500, 3_600),
        BudgetWindow("day", 9_000, 86_400),
    ),
)
"""Open-Meteo free tier at about 83% (decision D-19): location-calls per minute, hour and day."""

ROUTING: Final = Budget("routing", (BudgetWindow("minute", 40, 60),))
"""Routing provider calls per minute across all instances (the public servers allow ~1/s/user).

This is the only guarantee that holds *between* instances; the minimum interval of the routing
gate spaces calls inside one process only.
"""


class BudgetExhaustedError(Exception):
    """A window of the budget has too few tokens left; ``retry_after_s`` says when they will fit."""

    def __init__(self, budget: str, retry_after_s: float) -> None:
        """Record which ``budget`` ran dry and when it will have refilled enough."""
        super().__init__(f"upstream budget {budget} exhausted")
        self.budget = budget
        self.retry_after_s = retry_after_s


class UpstreamBudgetGuard:
    """Draws calls from the shared PostgreSQL budget."""

    def take(self, budget: Budget, cost: int) -> None:
        """Take ``cost`` calls from every window of ``budget``, or raise ``BudgetExhaustedError``.

        Raises:
            ValueError: ``cost`` is not positive or exceeds a window's burst (never fits).
            BudgetExhaustedError: some window cannot cover ``cost`` right now (nothing is taken).
        """
        if cost < 1 or any(cost > window.burst for window in budget.windows):
            raise ValueError("cost must be between 1 and the smallest window burst")
        refusal: float | None = None
        with transaction.atomic(), connection.cursor() as cursor:
            for window in budget.windows:
                cursor.execute(
                    "SELECT allowed, retry_after_ms "
                    "FROM app.upstream_budget_take(%s, %s, make_interval(secs => %s), %s, %s)",
                    [
                        f"{budget.name}:{window.name}",
                        window.rate,
                        window.window_s,
                        window.burst,
                        cost,
                    ],
                )
                ((allowed, retry_ms),) = cursor.fetchall()
                if not allowed:
                    refusal = retry_ms / _MS_PER_S
                    transaction.set_rollback(True)
                    break
        if refusal is not None:
            raise BudgetExhaustedError(budget.name, refusal)

    def attempt_hook(
        self, budget: Budget, provider: str, *, pace: Callable[[], None] | None = None
    ) -> Callable[[int], None]:
        """Return the ``before_attempt`` hook that spends ``budget`` for ``provider``.

        The hook runs before *every* attempt of a call, retries included (the upstream counts them
        all). ``pace`` (a minimum-interval gate, say) runs first, so the tokens are taken only when
        the attempt follows at once; a refusal reaches the caller as
        :class:`~haulcast.providers.errors.UpstreamBudgetExhaustedError` carrying the hint.
        """

        def before_attempt(cost: int) -> None:
            if pace is not None:
                pace()
            try:
                self.take(budget, cost)
            except BudgetExhaustedError as exc:
                raise UpstreamBudgetExhaustedError(
                    provider, f"{budget.name} budget exhausted", retry_after_s=exc.retry_after_s
                ) from exc

        return before_attempt
