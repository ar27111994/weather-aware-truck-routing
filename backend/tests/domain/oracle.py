"""An independent oracle for exact arithmetic: the brief's risk table and the ranking order.

Nothing here reads the implementation's logic. The thresholds are copied from the brief (with the
D-01 edge convention), every number is an exact ``Fraction`` of the value as written (D-02: the
shortest decimal form, the way a provider wrote it), quantization rounds half to even by comparing
the exact remainder, and the ranking is a pairwise comparator, not a key tuple. A property test
that checks the implementation against it compares two separate derivations of the contract
instead of the implementation with itself.

The domain dataclasses (``RouteCandidate``, ``RiskLevel``) are used as plain data containers.
"""

import functools
import math
from collections.abc import Callable, Sequence
from decimal import Decimal
from fractions import Fraction

from haulcast.domain import Factor, RiskLevel, RouteCandidate

# D-02 precision: wind in tenths of a mph, rain and snow in thousandths of an inch.
SCALE: dict[Factor, int] = {Factor.WIND: 10, Factor.RAIN: 1000, Factor.SNOW: 1000}

# The ranking tolerances (D-08): miles to 0.1, average risk to 0.001, duration to whole seconds.
MILES_SCALE, AVG_RISK_SCALE, DURATION_SCALE = 10, 1000, 1

LOW_COVERAGE_PERCENT = 10  # D-31: more than a tenth of the route's owned miles has no weather


def as_written(value: float) -> Fraction:
    """The value as its shortest decimal form reads, exactly (what ``repr`` prints)."""
    return Fraction(Decimal(repr(value)))


def half_even(exact: Fraction) -> int:
    """Round an exact rational to the nearest integer, ties to the even one."""
    floor = math.floor(exact)
    remainder = exact - floor
    if remainder > Fraction(1, 2):
        return floor + 1
    if remainder < Fraction(1, 2):
        return floor
    return floor if floor % 2 == 0 else floor + 1


def quantized(value: float, scale: int) -> int:
    """D-02: ``round_half_even(value * scale)``, computed exactly on the value as written."""
    return half_even(as_written(value) * scale)


# --------------------------------------------------------------------------- the brief's table
# | Wind | <25 mph | 25-34 | 35-44 | 45-54 | >=55 mph |
# | Rain | <0.10   | 0.10-0.25 | 0.25-0.50 | 0.50-1.00 | >1.00 |
# | Snow | <0.5    | 0.5-1.0   | 1.0-2.0   | 2.0-3.0   | >3.0  |
# D-01: a listed lower number is inclusive, the upper bound is the next band's lower number
# (exclusive), except that rain's and snow's Severe top is inclusive (No Travel is written ">").

LOW, MODERATE, HIGH = RiskLevel.LOW, RiskLevel.MODERATE, RiskLevel.HIGH
SEVERE, NO_TRAVEL = RiskLevel.SEVERE, RiskLevel.NO_TRAVEL


def wind_level(wind: Fraction) -> RiskLevel:
    """The brief's wind bands."""
    if wind >= 55:
        return NO_TRAVEL
    if wind >= 45:
        return SEVERE
    if wind >= 35:
        return HIGH
    if wind >= 25:
        return MODERATE
    return LOW


def rain_level(rain: Fraction) -> RiskLevel:
    """The brief's rain bands."""
    if rain > 1:
        return NO_TRAVEL
    if rain >= Fraction(1, 2):
        return SEVERE
    if rain >= Fraction(1, 4):
        return HIGH
    if rain >= Fraction(1, 10):
        return MODERATE
    return LOW


def snow_level(snow: Fraction) -> RiskLevel:
    """The brief's snow bands."""
    if snow > 3:
        return NO_TRAVEL
    if snow >= 2:
        return SEVERE
    if snow >= 1:
        return HIGH
    if snow >= Fraction(1, 2):
        return MODERATE
    return LOW


LEVEL_OF: dict[Factor, Callable[[Fraction], RiskLevel]] = {
    Factor.WIND: wind_level,
    Factor.RAIN: rain_level,
    Factor.SNOW: snow_level,
}

# Every band edge of the brief, so a test can cluster its inputs where the rounding matters.
EDGES: dict[Factor, tuple[Fraction, ...]] = {
    Factor.WIND: (Fraction(25), Fraction(35), Fraction(45), Fraction(55)),
    Factor.RAIN: (Fraction(1, 10), Fraction(1, 4), Fraction(1, 2), Fraction(1)),
    Factor.SNOW: (Fraction(1, 2), Fraction(1), Fraction(2), Fraction(3)),
}


def oracle_level(factor: Factor, value: float | None) -> RiskLevel | None:
    """The level the brief gives a value after D-02 quantization (``None``: missing or invalid)."""
    if value is None or not math.isfinite(value) or value < 0:
        return None
    scale = SCALE[factor]
    return LEVEL_OF[factor](Fraction(quantized(value, scale), scale))


# --------------------------------------------------------------------------- the ranking order


def _miles(route: RouteCandidate, level: RiskLevel) -> float:
    return route.stats.miles_by_level[level]


def owned_miles(route: RouteCandidate) -> Fraction:
    """The route's owned miles: every level's miles and the unknown miles, summed exactly."""
    return sum(
        (as_written(_miles(route, level)) for level in RiskLevel),
        start=as_written(route.stats.unknown_mi),
    )


def low_coverage(route: RouteCandidate) -> bool:
    """D-31: unknown miles are more than 10% of the owned miles, compared in 0.1 mi steps."""
    unknown = quantized(route.stats.unknown_mi, MILES_SCALE)
    owned = half_even(owned_miles(route) * MILES_SCALE)
    return unknown * 100 > owned * LOW_COVERAGE_PERCENT


Key = tuple[str, tuple[int, ...]]
"""One ranking key: the ``decided_by`` name it explains and its quantized value."""


def keys_of(route: RouteCandidate, *, coverage: bool = True) -> list[Key]:
    """The route's ranking keys in contract order.

    ``coverage=False`` leaves out the D-31 key: the ranking as it was before D-31.
    """
    no_travel = _miles(route, NO_TRAVEL)
    avg = route.stats.avg_risk
    keys: list[Key] = [
        ("no_travel_mi", (1 if no_travel > 0 else 0, quantized(no_travel, MILES_SCALE))),
    ]
    if coverage:
        keys.append(("coverage", (1 if low_coverage(route) else 0,)))
    keys += [
        ("severe_mi", (quantized(_miles(route, SEVERE), MILES_SCALE),)),
        ("high_mi", (quantized(_miles(route, HIGH), MILES_SCALE),)),
        ("avg_risk", (1, 0) if avg is None else (0, quantized(avg, AVG_RISK_SCALE))),
        ("duration_s", (quantized(route.duration_s, DURATION_SCALE),)),
    ]
    return keys


def _compare(first: RouteCandidate, second: RouteCandidate, *, coverage: bool) -> int:
    for (_, ours), (_, theirs) in zip(
        keys_of(first, coverage=coverage), keys_of(second, coverage=coverage), strict=True
    ):
        if ours != theirs:
            return -1 if ours < theirs else 1
    return 0


def oracle_order(routes: Sequence[RouteCandidate], *, coverage: bool = True) -> list[str]:
    """The route ids in rank order: the contract keys, then the provider's order (a stable sort)."""

    def compare(first: RouteCandidate, second: RouteCandidate) -> int:
        return _compare(first, second, coverage=coverage)

    ranked = sorted(routes, key=functools.cmp_to_key(compare))
    return [route.route_id for route in ranked]


def oracle_decided_by(routes: Sequence[RouteCandidate], *, coverage: bool = True) -> str:
    """The first key on which the best two routes differ; ``only_route`` for a single route."""
    if len(routes) == 1:
        return "only_route"
    by_id = {route.route_id: route for route in routes}
    first, second = (by_id[route_id] for route_id in oracle_order(routes, coverage=coverage)[:2])
    for (name, ours), (_, theirs) in zip(
        keys_of(first, coverage=coverage), keys_of(second, coverage=coverage), strict=True
    ):
        if ours != theirs:
            return name
    return "tie"


def oracle_status(routes: Sequence[RouteCandidate]) -> str:
    """``ok`` when the best route crosses no No Travel miles, else ``no_safe_route``."""
    by_id = {route.route_id: route for route in routes}
    best = by_id[oracle_order(routes)[0]]
    return "ok" if _miles(best, NO_TRAVEL) == 0 else "no_safe_route"
