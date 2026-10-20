"""Risk classification and assessment (DOMAIN-CONTRACT sections 2-4).

``classify`` places one factor value in its band on quantized integers (D-02). ``assess`` combines
the three factors of a checkpoint sample (D-04): the base level is the highest KNOWN factor level,
the wind-only load rules (LR-1..3) may escalate it, and the final level is the maximum of the two.
Missing data is UNKNOWN (``None``), never LOW; invalid provider values (negative, NaN, infinite) are
UNKNOWN too and are reported in ``warnings``.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import NamedTuple

from haulcast.domain.errors import InvalidLoadError
from haulcast.domain.forecast import WeatherSample
from haulcast.domain.levels import Factor, RiskLevel, WindMetric
from haulcast.domain.rules import FactorRules, LoadRule, RiskRules


@dataclass(frozen=True, slots=True)
class Assessment:
    """The risk at one checkpoint: final level, per-factor levels and the explanation.

    ``level`` is ``None`` (UNKNOWN) only when no factor is known. ``reasons`` are plain-English
    lines, the factor driving the final level first; ``warnings`` name invalid provider values.
    """

    level: RiskLevel | None
    factors: Mapping[Factor, RiskLevel | None]
    load_rule: str | None
    incomplete: bool
    reasons: tuple[str, ...]
    warnings: tuple[str, ...] = ()


class _Reading(NamedTuple):
    """One factor's classification and its reason line (``quantized`` is meaningful if known).

    A named tuple rather than a frozen dataclass: three are built per assessment, and a frozen
    dataclass pays an ``object.__setattr__`` call per field (see the ``perf`` budget tests).
    """

    factor: Factor
    level: RiskLevel | None
    line: str
    quantized: int = 0


def is_valid_reading(value: float) -> bool:
    """Return whether a provider value can be classified (finite and not negative)."""
    # One chained comparison: NaN fails both sides, negatives and infinity fail one of them.
    return 0.0 <= value < math.inf


def classify(factor: Factor, value: float | None, rules: RiskRules) -> RiskLevel | None:
    """Return the level of one factor value, or ``None`` when it is missing or invalid."""
    if value is None or not is_valid_reading(value):
        return None
    spec = rules.factors[factor]
    return spec.level_of(spec.quantize(value))


def assess(sample: WeatherSample, load_lb: int, rules: RiskRules) -> Assessment:
    """Assess one checkpoint sample for a truck carrying ``load_lb`` pounds.

    Raises:
        InvalidLoadError: ``load_lb`` is not an ``int`` inside the rules' load limits.
    """
    if type(load_lb) is not int or not rules.load_min_lb <= load_lb <= rules.load_max_lb:
        raise InvalidLoadError(
            f"load_lb must be a whole number of pounds in [{rules.load_min_lb}, "
            f"{rules.load_max_lb}], got {load_lb!r}"
        )
    wind = _wind_reading(sample, rules)
    readings = (
        wind,
        _reading(rules.factors[Factor.RAIN], sample.rain_in_hr, rules),
        _reading(rules.factors[Factor.SNOW], sample.snow_in_hr, rules),
    )
    fired = _fired_rule(wind, load_lb, rules)
    known = [reading.level for reading in readings if reading.level is not None]
    level = max(known, default=None)
    if level is not None and fired is not None:
        level = max(level, fired.result)
    return Assessment(
        level=level,
        factors=MappingProxyType({reading.factor: reading.level for reading in readings}),
        load_rule=fired.rule_id if fired is not None else None,
        incomplete=len(known) < len(readings),
        reasons=_reasons(readings, fired, load_lb, rules),
        warnings=_warnings(sample),
    )


def _reading(spec: FactorRules, value: float | None, rules: RiskRules) -> _Reading:
    if value is None:
        return _Reading(spec.factor, None, f"{spec.label} data unavailable")
    if not is_valid_reading(value):
        return _Reading(spec.factor, None, f"{spec.label} data invalid")
    quantized = spec.quantize(value)
    level = spec.level_of(quantized)
    line = f"{spec.label} {spec.format(quantized)} {spec.unit} ({rules.level_labels[level]})"
    return _Reading(spec.factor, level, line, quantized)


def _wind_reading(sample: WeatherSample, rules: RiskRules) -> _Reading:
    spec = rules.factors[Factor.WIND]
    sustained, gust = sample.wind_mph, sample.gust_mph
    metric = rules.wind_metric
    if metric is WindMetric.SUSTAINED:
        inputs: tuple[float | None, ...] = (sustained,)
    elif metric is WindMetric.GUST:
        inputs = (gust,)
    else:
        inputs = (sustained, gust)
    strongest: float | None = None
    for candidate in inputs:
        if candidate is None:
            continue
        if not is_valid_reading(candidate):
            return _Reading(Factor.WIND, None, f"{spec.label} data invalid")
        if strongest is None or candidate > strongest:
            strongest = candidate
    if strongest is None:
        return _Reading(Factor.WIND, None, f"{spec.label} data unavailable")
    quantized = spec.quantize(strongest)
    level = spec.level_of(quantized)
    value = f"{spec.format(quantized)} {spec.unit}"
    label = rules.level_labels[level]
    if metric is WindMetric.SUSTAINED:
        line = f"{spec.label} {value} ({label}){_suffix('gusts', gust, spec)}"
    elif metric is WindMetric.GUST:
        line = f"{spec.label} gusts {value} ({label}){_suffix('sustained', sustained, spec)}"
    else:
        line = (
            f"{spec.label} {value} ({label}), the higher of sustained "
            f"{_display(sustained, spec)} and gusts {_display(gust, spec)}"
        )
    return _Reading(Factor.WIND, level, line, quantized)


def _display(value: float | None, spec: FactorRules) -> str:
    """Format a secondary wind value for a reason line (``"unavailable"`` when unusable)."""
    if value is None or not is_valid_reading(value):
        return "unavailable"
    return f"{spec.format(spec.quantize(value))} {spec.unit}"


def _suffix(name: str, value: float | None, spec: FactorRules) -> str:
    """Return ``"; gusts 21.0 mph"``-style context for a valid secondary wind value."""
    if value is None or not is_valid_reading(value):
        return ""
    return f"; {name} {_display(value, spec)}"


def _fired_rule(wind: _Reading, load_lb: int, rules: RiskRules) -> LoadRule | None:
    """Return the load rule that applies to the wind reading (rules never overlap), if any."""
    if wind.level is None:
        return None
    for rule in rules.load_rules:
        if rule.fires(wind.quantized, load_lb):
            return rule
    return None


def _reasons(
    readings: tuple[_Reading, ...], fired: LoadRule | None, load_lb: int, rules: RiskRules
) -> tuple[str, ...]:
    """Order the reason lines: the highest driven level first, unavailable factors last.

    A factor's driven level is its own level, or for wind the fired load rule's result when that
    is higher; ties keep the canonical wind, rain, snow order. The load-rule line follows the wind
    line.
    """

    def driven(reading: _Reading) -> int:
        level = reading.level if reading.level is not None else -1
        if fired is not None and reading.factor is Factor.WIND:
            return max(level, fired.result)
        return level

    lines: list[str] = []
    for reading in sorted(readings, key=driven, reverse=True):
        lines.append(reading.line)
        if fired is not None and reading.factor is Factor.WIND:
            lines.append(_rule_line(fired, readings[0], load_lb, rules))
    return tuple(lines)


def _rule_line(rule: LoadRule, wind: _Reading, load_lb: int, rules: RiskRules) -> str:
    spec = rules.factors[Factor.WIND]
    value = f"{spec.format(wind.quantized)} {spec.unit}"
    result = rules.level_labels[rule.result]
    if rule.load_lb_above is None:
        return f"{spec.label} {value}: {result} for any load ({rule.rule_id})"
    return (
        f"Load {load_lb:,} lb is above {rule.load_lb_above:,} lb with "
        f"{spec.label.lower()} {value}: {result} ({rule.rule_id})"
    )


def _warnings(sample: WeatherSample) -> tuple[str, ...]:
    inputs = (
        ("sustained wind", sample.wind_mph),
        ("wind gust", sample.gust_mph),
        ("rain", sample.rain_in_hr),
        ("snow", sample.snow_in_hr),
    )
    # A list comprehension is inlined (PEP 709); a generator would add a frame per call.
    invalid = [name for name, value in inputs if value is not None and not is_valid_reading(value)]
    if not invalid:
        return ()
    values = dict(inputs)
    return tuple(
        f"Invalid {name} value {values[name]!r} from the weather provider was ignored"
        for name in invalid
    )
