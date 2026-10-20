"""Global upstream budgets: refuse to call a rate-limited upstream *before* it refuses us.

Open-Meteo bills one call per location and limits its free tier per egress IP (600/min, 5,000/h,
10,000/day). Vercel instances share egress addresses, so a purely local counter cannot know how much
of the allowance is left. The budget lives in PostgreSQL (``app.upstream_budget_take``, the
same atomic GCRA function that rate-limits clients) at roughly 83% of the free limits, so
every instance draws from one shared pool and a spike degrades to a clean
``weather_capacity_exhausted`` 503 with a ``Retry-After`` instead of an upstream 429.

A take spans all windows of a budget (minute/hour/day) and is all-or-nothing: if any window refuses,
the tokens already taken from the others are given back.
"""

from dataclasses import dataclass
from typing import Final

from django.db import connection, transaction

_MS_PER_S: Final = 1000.0


@dataclass(frozen=True, slots=True)
class BudgetWindow:
    """``limit`` upstream calls per ``window_s`` seconds (the bucket holds ``limit`` tokens)."""

    name: str
    limit: int
    window_s: int


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
"""Routing provider calls per minute across all instances (the public servers allow ~1/s/user)."""


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
            ValueError: ``cost`` is not positive or exceeds a window's capacity (never fits).
            BudgetExhaustedError: some window cannot cover ``cost`` right now (nothing is taken).
        """
        if cost < 1 or any(cost > window.limit for window in budget.windows):
            raise ValueError("cost must be between 1 and the smallest window limit")
        refusal: float | None = None
        with transaction.atomic(), connection.cursor() as cursor:
            for window in budget.windows:
                cursor.execute(
                    "SELECT allowed, retry_after_ms "
                    "FROM app.upstream_budget_take(%s, %s, make_interval(secs => %s), %s, %s)",
                    [
                        f"{budget.name}:{window.name}",
                        window.limit,
                        window.window_s,
                        window.limit,
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
