"""Route statistics and the recommendation (DOMAIN-CONTRACT sections 7-8).

``summarize`` turns a route's checkpoints and their assessments into mile-weighted statistics.
``rank_routes`` orders candidate routes by the lexicographic key
``(no_travel_mi, low_coverage, severe_mi, high_mi, avg_risk, duration_s)``, fixed by the contract
and pinned by the rules schema, compared on the rules file's tolerances (miles to 0.1, average
risk to 0.001, duration to whole seconds) so float noise never decides, then by the provider's
order (a stable sort).

Two keys extend the brief's four. No Travel miles rank first: No Travel is strictly worse than
Severe, and the key also carries a presence flag, so a route with any No Travel miles never beats
one with none, even when its No Travel miles round to 0.0. Coverage ranks second (D-31): unknown
miles are not evidence of safety, so a route with weather missing for more than 10% of its miles
never beats a route that has more of it, however few Severe miles the known part shows.
"""

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from haulcast.domain.errors import InvalidAssessmentsError, InvalidCandidatesError
from haulcast.domain.levels import RiskLevel
from haulcast.domain.quantize import quantize_exactly
from haulcast.domain.risk import Assessment
from haulcast.domain.rules import RiskRules
from haulcast.domain.sampling import Checkpoint

_MAX_AVG_RISK: Final = float(RiskLevel.NO_TRAVEL)
_SECONDS_PER_MINUTE: Final = 60
_MINUTES_PER_HOUR: Final = 60
_TEENS: Final = range(11, 14)
_ORDINAL_SUFFIXES: Final = {1: "st", 2: "nd", 3: "rd"}

LOW_COVERAGE_UNKNOWN_PERCENT: Final = 10
"""D-31: a route is low-coverage when more than this percentage of its miles has no weather."""

_PERCENT: Final = 100
_TENTHS: Final = 10
_PERCENT_STEPS: Final = _PERCENT * _TENTHS
"""Shares are shown in tenths of a percent, so the figure and the ``low_coverage`` verdict agree."""


class DecidedBy(StrEnum):
    """The ranking key on which the recommended route beat the runner-up (D-08, D-31)."""

    NO_TRAVEL_MI = "no_travel_mi"
    COVERAGE = "coverage"
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

    @property
    def owned_mi(self) -> float:
        """The route's owned miles: every checkpoint's stretch, known or not (D-06)."""
        return math.fsum((*self.miles_by_level.values(), self.unknown_mi))


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


RankingKey = tuple[int, int, int, int, int, tuple[int, int], int]
"""``(has_no_travel, no_travel, low_coverage, severe, high, (avg_unknown, avg_risk), duration)``."""

_KEY_FIELDS: Final = (
    DecidedBy.NO_TRAVEL_MI,
    DecidedBy.NO_TRAVEL_MI,
    DecidedBy.COVERAGE,
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


def _unknown_and_owned_steps(stats: RouteRiskStats, rules: RiskRules) -> tuple[int, int]:
    """The route's unknown and owned miles in steps of the ranking's miles tolerance (0.1 mi)."""
    scale = rules.ranking.miles_scale
    return quantize_exactly(stats.unknown_mi, scale), quantize_exactly(stats.owned_mi, scale)


def is_low_coverage(stats: RouteRiskStats, rules: RiskRules) -> bool:
    """Whether weather is missing for more than 10% of the route's owned miles (D-31).

    Both sides are compared in whole steps of the miles tolerance, after its rounding, so float
    noise in the sums never decides and exactly 10.0% is not low.
    """
    unknown, owned = _unknown_and_owned_steps(stats, rules)
    return unknown * _PERCENT > owned * LOW_COVERAGE_UNKNOWN_PERCENT


def _unknown_share(stats: RouteRiskStats, rules: RiskRules) -> str:
    """The unknown share of the route's owned miles as a percentage, rounded up to 0.1%.

    Rounding up keeps the figure consistent with ``is_low_coverage``: a share shown above 10.0% is
    exactly a low-coverage route, and a positive share is never shown as zero.
    """
    unknown, owned = _unknown_and_owned_steps(stats, rules)
    whole = max(owned, 1)  # no miles, nothing unknown: the share is 0.0%
    tenths = (_PERCENT_STEPS * unknown + whole - 1) // whole
    percent, tenth = divmod(tenths, _TENTHS)
    return f"{percent}.{tenth}%"


def ranking_key(candidate: RouteCandidate, rules: RiskRules) -> RankingKey:
    """Return the quantized lexicographic key of a route: lower ranks first (D-08, D-31)."""
    tolerances = rules.ranking
    miles = candidate.stats.miles_by_level
    avg = candidate.stats.avg_risk
    return (
        1 if miles[RiskLevel.NO_TRAVEL] > 0 else 0,
        quantize_exactly(miles[RiskLevel.NO_TRAVEL], tolerances.miles_scale),
        1 if is_low_coverage(candidate.stats, rules) else 0,
        quantize_exactly(miles[RiskLevel.SEVERE], tolerances.miles_scale),
        quantize_exactly(miles[RiskLevel.HIGH], tolerances.miles_scale),
        (1, 0) if avg is None else (0, quantize_exactly(avg, tolerances.avg_risk_scale)),
        quantize_exactly(candidate.duration_s, tolerances.duration_scale),
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
        warnings=_warnings(ranked, rules),
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
                f"{_duration(round(best.duration_s))}{self._coverage_clause(best)}."
            )
        other = self.ranked[1]
        lead = f"{best.name} is recommended: "
        if decided_by is DecidedBy.COVERAGE:  # the best route is the one that is not low-coverage
            return (
                f"{lead}it has the smallest share of miles without weather data "
                f"({self._share(best)} vs {self._share(other)} on {other.name}); "
                f"{self._time_note(best)}."
            )
        note = self._notes(best)
        if decided_by in _MILES_LEVELS:
            return self._miles_recommendation(lead, _MILES_LEVELS[decided_by], note)
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

    def _miles_recommendation(self, lead: str, level: RiskLevel, note: str) -> str:
        """The recommendation when the best route won on fewer miles at ``level``."""
        best, other = self.ranked[0], self.ranked[1]
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

    def _runner_up(self, rank: int, candidate: RouteCandidate, decided_by: DecidedBy) -> str:
        best = self.ranked[0]
        lead = f"{candidate.name} ranks {_ordinal(rank)}: "
        if decided_by is DecidedBy.COVERAGE:  # the runner-up is the low-coverage route
            return (
                f"{lead}{self._share(candidate)} of its miles have no weather data vs "
                f"{self._share(best)} on {best.name}; {self._time_note(candidate)}."
            )
        note = self._notes(candidate)
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
        return f"{quantize_exactly(avg, scale) / scale:.{_decimals(scale)}f}"

    def _share(self, candidate: RouteCandidate) -> str:
        return _unknown_share(candidate.stats, self.rules)

    def _time_note(self, candidate: RouteCandidate) -> str:
        extra = round(candidate.duration_s) - self.fastest_s
        if extra == 0:
            return "the fastest option"
        return f"+{_duration(extra)} vs the fastest option"

    def _coverage_clause(self, candidate: RouteCandidate) -> str:
        """Cite a low-coverage route's unknown share (nothing for a route with enough weather)."""
        if not is_low_coverage(candidate.stats, self.rules):
            return ""
        return f"; {self._share(candidate)} of its miles have no weather data"

    def _notes(self, candidate: RouteCandidate) -> str:
        """The closing remarks about a route: its time against the fastest, and its coverage."""
        return self._time_note(candidate) + self._coverage_clause(candidate)


def _decimals(scale: int) -> int:
    """Return the decimals of a power-of-ten scale (``10`` -> 1, ``1000`` -> 3)."""
    return len(str(scale)) - 1


def _quantity(value: float, scale: int) -> str:
    """Format miles at the ranking tolerance, never showing a positive amount as zero."""
    quantized = quantize_exactly(value, scale)
    if quantized == 0 and value > 0:
        return f"less than {1 / scale:.{_decimals(scale)}f}"
    return f"{quantized / scale:,.{_decimals(scale)}f}"


def _distance(miles: float) -> str:
    """Format a route distance to 0.1 mi with thousands separators."""
    return f"{miles:,.1f}"


def _gap_warning(candidate: RouteCandidate, rules: RiskRules) -> str:
    """Say that part of a route has no weather; a low-coverage route also states its share."""
    stats = candidate.stats
    unknown = _quantity(stats.unknown_mi, rules.ranking.miles_scale)
    share = f" ({_unknown_share(stats, rules)})" if is_low_coverage(stats, rules) else ""
    return (
        f"{candidate.name} has no usable weather data for {unknown} of its "
        f"{_distance(candidate.distance_mi)} miles{share}; its risk may be understated."
    )


def _warnings(ranked: Sequence[RouteCandidate], rules: RiskRules) -> tuple[str, ...]:
    """Warn about incomplete weather: every low-coverage route, and a recommended route with gaps.

    When every route is low-coverage (and there is more than one) the coverage key ties, so a final
    line says that coverage could not separate them (D-31).
    """
    lines = [
        _gap_warning(candidate, rules)
        for position, candidate in enumerate(ranked)
        if is_low_coverage(candidate.stats, rules)
        or (position == 0 and candidate.stats.unknown_mi > 0)
    ]
    if len(ranked) > 1 and all(is_low_coverage(candidate.stats, rules) for candidate in ranked):
        lines.append(
            f"Weather data is missing for more than {LOW_COVERAGE_UNKNOWN_PERCENT}% of the miles "
            "of every route, so coverage cannot separate them and the recommendation rests on "
            "the weather that is known."
        )
    return tuple(lines)
