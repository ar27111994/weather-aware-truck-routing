"""Route statistics and the recommendation (DOMAIN-CONTRACT sections 7-8).

``summarize`` turns a route's checkpoints and their assessments into mile-weighted statistics.
``rank_routes`` orders candidate routes by the lexicographic key
``(no_travel_mi, severe_mi, high_mi, avg_risk, duration_s)``, fixed by the contract and pinned by
the rules schema, compared on the rules file's tolerances (miles to 0.1, average risk to 0.001,
duration to whole seconds) so float noise never decides, then by the provider's order (a stable
sort). No Travel miles rank first, an explicit extension of the brief: No Travel is strictly worse
than Severe. The key also carries a presence flag, so a route with any No Travel miles never beats
one with none, even when its No Travel miles round to 0.0.
"""

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from haulcast.domain.errors import InvalidAssessmentsError, InvalidCandidatesError
from haulcast.domain.levels import RiskLevel
from haulcast.domain.risk import Assessment
from haulcast.domain.rules import RiskRules
from haulcast.domain.sampling import Checkpoint

_MAX_AVG_RISK: Final = float(RiskLevel.NO_TRAVEL)
_SECONDS_PER_MINUTE: Final = 60
_MINUTES_PER_HOUR: Final = 60
_TEENS: Final = range(11, 14)
_ORDINAL_SUFFIXES: Final = {1: "st", 2: "nd", 3: "rd"}


class DecidedBy(StrEnum):
    """The ranking key on which the recommended route beat the runner-up (D-08)."""

    NO_TRAVEL_MI = "no_travel_mi"
    SEVERE_MI = "severe_mi"
    HIGH_MI = "high_mi"
    AVG_RISK = "avg_risk"
    DURATION_S = "duration_s"
    TIE = "tie"
    ONLY_ROUTE = "only_route"


class RouteStatus(StrEnum):
    """``OK`` when the recommended route crosses no No Travel miles, else ``NO_SAFE_ROUTE``."""

    OK = "ok"
    NO_SAFE_ROUTE = "no_safe_route"


@dataclass(frozen=True, slots=True)
class RouteRiskStats:
    """Mile-weighted risk statistics of one route (D-07).

    ``miles_by_level`` always has all five levels (0.0 when none); ``unknown_mi`` counts the miles
    whose checkpoint had no usable weather; ``avg_risk`` is the mile-weighted mean ordinal of the
    known miles, in ``[0, 4]``; ``avg_risk`` and ``max_level`` are ``None`` when nothing is known.
    """

    miles_by_level: Mapping[RiskLevel, float]
    unknown_mi: float
    avg_risk: float | None
    max_level: RiskLevel | None

    def __post_init__(self) -> None:
        """Reject statistics that cannot be ranked (missing levels, invalid numbers)."""
        miles = (*self.miles_by_level.values(), self.unknown_mi)
        if set(self.miles_by_level) != set(RiskLevel) or not all(
            math.isfinite(value) and value >= 0 for value in miles
        ):
            raise InvalidCandidatesError(
                "route statistics need finite, non-negative miles for every risk level"
            )
        if self.avg_risk is not None and not 0 <= self.avg_risk <= _MAX_AVG_RISK:
            raise InvalidCandidatesError(f"average risk {self.avg_risk!r} is outside [0, 4]")


@dataclass(frozen=True, slots=True)
class RouteCandidate:
    """One route offered by the routing provider, with its risk statistics.

    ``label`` is the display name used in the rationale (``"Route A"`` when omitted).
    """

    route_id: str
    duration_s: float
    distance_mi: float
    stats: RouteRiskStats
    label: str | None = None

    def __post_init__(self) -> None:
        """Reject an empty id and provider numbers that cannot be ranked or shown."""
        if not self.route_id:
            raise InvalidCandidatesError("a route needs a non-empty route_id")
        for name, value in (("duration_s", self.duration_s), ("distance_mi", self.distance_mi)):
            if not (math.isfinite(value) and value >= 0):
                raise InvalidCandidatesError(
                    f"route {self.route_id}: {name} must be finite and non-negative, got {value!r}"
                )

    @property
    def name(self) -> str:
        """The display name: the label, or ``"Route <id>"``."""
        return self.label or f"Route {self.route_id}"


@dataclass(frozen=True, slots=True)
class Ranking:
    """The ranked routes and the plain-English explanation of the recommendation."""

    order: tuple[str, ...]
    recommended_id: str
    decided_by: DecidedBy
    status: RouteStatus
    rationale: tuple[str, ...]
    warnings: tuple[str, ...]


RankingKey = tuple[int, int, int, int, tuple[int, int], int]
"""``(has_no_travel, no_travel, severe, high, (avg_unknown, avg_risk), duration)`` quantized."""

_KEY_FIELDS: Final = (
    DecidedBy.NO_TRAVEL_MI,
    DecidedBy.NO_TRAVEL_MI,
    DecidedBy.SEVERE_MI,
    DecidedBy.HIGH_MI,
    DecidedBy.AVG_RISK,
    DecidedBy.DURATION_S,
)
"""The contract key each ``RankingKey`` position belongs to."""

_MILES_LEVELS: Final = {
    DecidedBy.NO_TRAVEL_MI: RiskLevel.NO_TRAVEL,
    DecidedBy.SEVERE_MI: RiskLevel.SEVERE,
    DecidedBy.HIGH_MI: RiskLevel.HIGH,
}


def summarize(
    checkpoints: Sequence[Checkpoint], assessments: Sequence[Assessment]
) -> RouteRiskStats:
    """Aggregate a route's checkpoint assessments, weighting each by its owned miles (D-07).

    Raises:
        InvalidAssessmentsError: The two sequences do not pair up one-to-one.
    """
    if len(checkpoints) != len(assessments):
        raise InvalidAssessmentsError(
            f"{len(checkpoints)} checkpoints cannot pair with {len(assessments)} assessments"
        )
    owned: dict[RiskLevel | None, list[float]] = {level: [] for level in (*RiskLevel, None)}
    for checkpoint, assessment in zip(checkpoints, assessments, strict=True):
        owned[assessment.level].append(checkpoint.owned_mi)
    known = [(level, miles) for level in RiskLevel for miles in owned[level]]
    known_mi = math.fsum(miles for _, miles in known)
    return RouteRiskStats(
        miles_by_level=MappingProxyType({level: math.fsum(owned[level]) for level in RiskLevel}),
        unknown_mi=math.fsum(owned[None]),
        avg_risk=math.fsum(level * miles for level, miles in known) / known_mi if known else None,
        max_level=max((level for level in RiskLevel if owned[level]), default=None),
    )


def ranking_key(candidate: RouteCandidate, rules: RiskRules) -> RankingKey:
    """Return the quantized lexicographic key of a route: lower ranks first (D-08)."""
    tolerances = rules.ranking
    miles = candidate.stats.miles_by_level
    avg = candidate.stats.avg_risk
    return (
        1 if miles[RiskLevel.NO_TRAVEL] > 0 else 0,
        round(miles[RiskLevel.NO_TRAVEL] * tolerances.miles_scale),
        round(miles[RiskLevel.SEVERE] * tolerances.miles_scale),
        round(miles[RiskLevel.HIGH] * tolerances.miles_scale),
        (1, 0) if avg is None else (0, round(avg * tolerances.avg_risk_scale)),
        round(candidate.duration_s * tolerances.duration_scale),
    )


def rank_routes(candidates: Sequence[RouteCandidate], rules: RiskRules) -> Ranking:
    """Rank candidate routes, pick the recommendation and explain it (D-08).

    The ranking is a pure function of the candidates: permuting them changes the result only
    among routes whose keys are equal, which keep their input (provider) order.

    Raises:
        InvalidCandidatesError: There are no candidates or two share a ``route_id``.
    """
    if not candidates:
        raise InvalidCandidatesError("at least one route is needed to rank")
    ids = [candidate.route_id for candidate in candidates]
    duplicates = sorted({route_id for route_id in ids if ids.count(route_id) > 1})
    if duplicates:
        raise InvalidCandidatesError(f"duplicate route ids: {', '.join(duplicates)}")
    keyed = sorted(
        ((ranking_key(candidate, rules), candidate) for candidate in candidates),
        key=lambda pair: pair[0],
    )
    ranked = [candidate for _, candidate in keyed]
    best = ranked[0]
    decided_by = _decided_by(keyed[0][0], keyed[1][0]) if len(keyed) > 1 else DecidedBy.ONLY_ROUTE
    status = (
        RouteStatus.OK
        if best.stats.miles_by_level[RiskLevel.NO_TRAVEL] == 0
        else RouteStatus.NO_SAFE_ROUTE
    )
    return Ranking(
        order=tuple(candidate.route_id for candidate in ranked),
        recommended_id=best.route_id,
        decided_by=decided_by,
        status=status,
        rationale=_Explainer(ranked, rules).rationale(decided_by, status),
        warnings=_warnings(best, rules),
    )


def _decided_by(first: RankingKey, second: RankingKey) -> DecidedBy:
    """Return the first contract key on which two ranking keys differ (``TIE`` when none)."""
    for field, ours, theirs in zip(_KEY_FIELDS, first, second, strict=True):
        if ours != theirs:
            return field
    return DecidedBy.TIE


def _ordinal(rank: int) -> str:
    """Return ``"1st"``, ``"2nd"``, ``"11th"``, ``"23rd"`` and so on."""
    if rank % 100 in _TEENS:
        return f"{rank}th"
    return f"{rank}{_ORDINAL_SUFFIXES.get(rank % 10, 'th')}"


def _duration(seconds: int) -> str:
    """Format whole seconds for people: ``"45 s"``, ``"38 min"``, ``"7 h 05 min"``."""
    if seconds < _SECONDS_PER_MINUTE:
        return f"{seconds} s"
    minutes = (seconds + _SECONDS_PER_MINUTE // 2) // _SECONDS_PER_MINUTE
    if minutes < _MINUTES_PER_HOUR:
        return f"{minutes} min"
    hours, minutes = divmod(minutes, _MINUTES_PER_HOUR)
    return f"{hours} h {minutes:02d} min"


class _Explainer:
    """Builds the rationale sentences for one ranking, formatting numbers like the rules do."""

    def __init__(self, ranked: Sequence[RouteCandidate], rules: RiskRules) -> None:
        self.ranked = ranked
        self.rules = rules
        self.keys = [ranking_key(candidate, rules) for candidate in ranked]
        self.fastest_s = min(round(candidate.duration_s) for candidate in ranked)

    def rationale(self, decided_by: DecidedBy, status: RouteStatus) -> tuple[str, ...]:
        """Explain the recommendation, then why each other route ranks below it."""
        best = self.ranked[0]
        lines: list[str] = []
        if status is RouteStatus.NO_SAFE_ROUTE:
            lines.append(
                f"Every route crosses {self._label(RiskLevel.NO_TRAVEL)} conditions: none is safe "
                f"to drive now, and {best.name} is the least exposed."
            )
        lines.append(self._recommendation(decided_by))
        lines.extend(
            self._runner_up(rank, candidate, _decided_by(self.keys[0], key))
            for rank, (candidate, key) in enumerate(
                zip(self.ranked[1:], self.keys[1:], strict=True), start=2
            )
        )
        return tuple(lines)

    def _recommendation(self, decided_by: DecidedBy) -> str:
        best = self.ranked[0]
        if decided_by is DecidedBy.ONLY_ROUTE:
            return (
                f"{best.name} is the only route found: {_distance(best.distance_mi)} mi in "
                f"{_duration(round(best.duration_s))}."
            )
        other = self.ranked[1]
        lead = f"{best.name} is recommended: "
        note = self._time_note(best)
        if decided_by in _MILES_LEVELS:
            level = _MILES_LEVELS[decided_by]
            ours, theirs = self._miles(best, level), self._miles(other, level)
            if best.stats.miles_by_level[level] == 0:
                return (
                    f"{lead}it avoids {self._label(level)} conditions that {other.name} crosses "
                    f"for {theirs} mi; {note}."
                )
            return (
                f"{lead}it has the fewest {self._label(level)} miles ({ours} vs {theirs} on "
                f"{other.name}); {note}."
            )
        if decided_by is DecidedBy.AVG_RISK:
            return (
                f"{lead}it has the lowest average risk ({self._avg(best)} vs {self._avg(other)} "
                f"on {other.name}); {note}."
            )
        if decided_by is DecidedBy.DURATION_S:
            return (
                f"{lead}it matches {other.name} on risk and is faster "
                f"({_duration(round(best.duration_s))} vs {_duration(round(other.duration_s))}); "
                f"{note}."
            )
        return (
            f"{lead}it ties {other.name} on every criterion and comes first in the routing "
            f"provider's order; {note}."
        )

    def _runner_up(self, rank: int, candidate: RouteCandidate, decided_by: DecidedBy) -> str:
        best = self.ranked[0]
        lead = f"{candidate.name} ranks {_ordinal(rank)}: "
        note = self._time_note(candidate)
        if decided_by in _MILES_LEVELS:
            level = _MILES_LEVELS[decided_by]
            return (
                f"{lead}{self._miles(candidate, level)} {self._label(level)} miles vs "
                f"{self._miles(best, level)} on {best.name}; {note}."
            )
        if decided_by is DecidedBy.AVG_RISK:
            return (
                f"{lead}average risk {self._avg(candidate)} vs {self._avg(best)} on {best.name}; "
                f"{note}."
            )
        if decided_by is DecidedBy.DURATION_S:
            return (
                f"{lead}same risk as {best.name} but slower "
                f"({_duration(round(candidate.duration_s))} vs "
                f"{_duration(round(best.duration_s))}); {note}."
            )
        return (
            f"{lead}it ties {best.name} on every criterion and comes later in the routing "
            f"provider's order; {note}."
        )

    def _label(self, level: RiskLevel) -> str:
        return self.rules.level_labels[level]

    def _miles(self, candidate: RouteCandidate, level: RiskLevel) -> str:
        return _quantity(candidate.stats.miles_by_level[level], self.rules.ranking.miles_scale)

    def _avg(self, candidate: RouteCandidate) -> str:
        avg = candidate.stats.avg_risk
        if avg is None:
            return "unknown"
        scale = self.rules.ranking.avg_risk_scale
        return f"{round(avg * scale) / scale:.{_decimals(scale)}f}"

    def _time_note(self, candidate: RouteCandidate) -> str:
        extra = round(candidate.duration_s) - self.fastest_s
        if extra == 0:
            return "the fastest option"
        return f"+{_duration(extra)} vs the fastest option"


def _decimals(scale: int) -> int:
    """Return the decimals of a power-of-ten scale (``10`` -> 1, ``1000`` -> 3)."""
    return len(str(scale)) - 1


def _quantity(value: float, scale: int) -> str:
    """Format miles at the ranking tolerance, never showing a positive amount as zero."""
    quantized = round(value * scale)
    if quantized == 0 and value > 0:
        return f"less than {1 / scale:.{_decimals(scale)}f}"
    return f"{quantized / scale:,.{_decimals(scale)}f}"


def _distance(miles: float) -> str:
    """Format a route distance to 0.1 mi with thousands separators."""
    return f"{miles:,.1f}"


def _warnings(best: RouteCandidate, rules: RiskRules) -> tuple[str, ...]:
    """Warn when the recommended route's risk rests on incomplete weather data."""
    if best.stats.unknown_mi == 0:
        return ()
    unknown = _quantity(best.stats.unknown_mi, rules.ranking.miles_scale)
    warning = (
        f"{best.name} has no usable weather data for {unknown} of its "
        f"{_distance(best.distance_mi)} miles; its risk may be understated."
    )
    return (warning,)
