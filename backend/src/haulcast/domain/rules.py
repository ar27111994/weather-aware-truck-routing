"""Risk rules: the typed, validated form of ``shared/risk-rules.json`` (DOMAIN-CONTRACT 2, 4, 8).

Thresholds are data. ``load_rules`` validates a parsed document against the shared JSON Schema
(2020-12) and then enforces the invariants a schema cannot express: bands that meet exactly once
(contiguous, non-overlapping), strictly increasing thresholds, thresholds on the precision grid,
load-rule wind ranges inside a single wind band, unique load-rule ids, ordered load limits and a
listed default interval. Every problem is collected and raised together as one
``RulesValidationError``.

Values are classified on quantized integers (D-02): ``round_half_even(value / precision)``, so a
float such as ``0.09999999999`` lands on the intended band edge.
"""

import json
import math
import os
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

from jsonschema import Draft202012Validator

from haulcast.domain.errors import RulesValidationError
from haulcast.domain.levels import Factor, RiskLevel, WindMetric

RULES_SCHEMA_ID: Final = "urn:haulcast:schema:risk-rules:v1"
"""``$id`` of ``shared/risk-rules.schema.json``: the only schema ``load_rules`` accepts."""

SCHEMA_FILENAME: Final = "risk-rules.schema.json"
_GRID_TOLERANCE: Final = 1e-6
_LEVELS: Final = tuple(RiskLevel)
"""Levels by ordinal: indexing is much cheaper than calling ``RiskLevel(n)`` on the hot path."""


@dataclass(frozen=True, slots=True)
class FactorRules:
    """One factor's bands, quantized to integer steps of ``precision``.

    ``band_starts`` holds the first quantized value of MODERATE, HIGH, SEVERE and NO_TRAVEL, so
    ``band_starts.count(start <= q)`` is the level of a quantized value ``q``.
    """

    factor: Factor
    label: str
    unit: str
    precision: float
    scale: int
    decimals: int
    band_starts: tuple[int, ...]

    def quantize(self, value: float) -> int:
        """Return ``value`` as a whole number of precision steps (round half to even)."""
        return round(value * self.scale)

    def level_of(self, quantized: int) -> RiskLevel:
        """Return the level of a quantized, non-negative value."""
        return _LEVELS[bisect_right(self.band_starts, quantized)]

    def format(self, quantized: int) -> str:
        """Format a quantized value with exactly the precision's decimals (``"0.250"``)."""
        return f"{quantized / self.scale:.{self.decimals}f}"


@dataclass(frozen=True, slots=True)
class LoadRule:
    """A wind-only load escalation (brief: Load rules), on quantized wind values.

    It fires when ``wind_min_q <= wind_q`` (and ``wind_q < wind_max_q`` when bounded) and, unless
    ``load_lb_above`` is ``None`` (any load), ``load_lb > load_lb_above``.
    """

    rule_id: str
    wind_min_q: int
    wind_max_q: int | None
    load_lb_above: int | None
    result: RiskLevel

    def fires(self, wind_q: int, load_lb: int) -> bool:
        """Return whether the rule applies to this quantized wind value and load."""
        return (
            wind_q >= self.wind_min_q
            and (self.wind_max_q is None or wind_q < self.wind_max_q)
            and (self.load_lb_above is None or load_lb > self.load_lb_above)
        )


@dataclass(frozen=True, slots=True)
class RankingRules:
    """Ranking tolerances as integer scales: a value is compared as ``round(value * scale)``."""

    miles_scale: int
    avg_risk_scale: int
    duration_scale: int


@dataclass(frozen=True, slots=True)
class RiskRules:
    """Everything the domain reads from ``shared/risk-rules.json``, validated and immutable."""

    version: str
    level_labels: Mapping[RiskLevel, str]
    factors: Mapping[Factor, FactorRules]
    wind_metric: WindMetric
    load_rules: tuple[LoadRule, ...]
    ranking: RankingRules
    load_min_lb: int
    load_max_lb: int
    assumed_tare_lb: int
    sampling_intervals_mi: tuple[int, ...]
    default_sampling_interval_mi: int


def load_rules(document: Mapping[str, Any], schema: Mapping[str, Any]) -> RiskRules:
    """Validate a parsed rules document against ``schema`` and return the typed rules.

    Args:
        document: The parsed ``risk-rules.json`` (as produced by ``json.load``).
        schema: The parsed ``risk-rules.schema.json``; its ``$id`` must be ``RULES_SCHEMA_ID``.

    Raises:
        RulesValidationError: The schema is not the rules schema or is invalid, the document
            breaks the schema, or the document breaks a semantic invariant.
    """
    _check_against_schema(document, schema)
    problems: list[str] = []
    factors = {f: _parse_factor(f, document["factors"][f.value], problems) for f in Factor}
    limits = document["load_limits_lb"]
    load_min, load_max = limits["min"], limits["max"]
    if load_min >= load_max:
        problems.append(f"load_limits_lb: min {load_min} must be below max {load_max}")
    load_rules_ = _parse_load_rules(
        document["load_rules"], factors[Factor.WIND], (load_min, load_max), problems
    )
    intervals = tuple(document["sampling_intervals_mi"])
    default_interval = document["default_sampling_interval_mi"]
    if default_interval not in intervals:
        problems.append(
            f"default_sampling_interval_mi: {default_interval} is not one of "
            f"sampling_intervals_mi {list(intervals)}"
        )
    if problems:
        raise RulesValidationError(problems)
    tolerances = document["ranking"]["tolerances"]
    return RiskRules(
        version=document["version"],
        level_labels=MappingProxyType(
            {RiskLevel(level["ordinal"]): level["label"] for level in document["levels"]}
        ),
        factors=MappingProxyType(factors),
        wind_metric=WindMetric(document["factors"]["wind"]["metric"]),
        load_rules=load_rules_,
        ranking=RankingRules(
            miles_scale=_scale(tolerances["miles"]),
            avg_risk_scale=_scale(tolerances["avg_risk"]),
            duration_scale=_scale(tolerances["duration_s"]),
        ),
        load_min_lb=load_min,
        load_max_lb=load_max,
        assumed_tare_lb=document["assumed_tare_lb"],
        sampling_intervals_mi=intervals,
        default_sampling_interval_mi=default_interval,
    )


def load_rules_file(
    path: str | os.PathLike[str], *, schema_path: str | os.PathLike[str] | None = None
) -> RiskRules:
    """Read a rules file (and its schema, by default the sibling ``risk-rules.schema.json``).

    This is the domain's only I/O: a thin wrapper around ``load_rules``. ``OSError`` (for example
    a missing file) propagates unchanged; malformed JSON raises ``RulesValidationError``.
    """
    rules_path = Path(path)
    schema_location = (
        Path(schema_path) if schema_path is not None else rules_path.with_name(SCHEMA_FILENAME)
    )
    return load_rules(_read_json(rules_path), _read_json(schema_location))


def _read_json(path: Path) -> Mapping[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        parsed: object = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RulesValidationError(
            [f"$: {path.name} is not valid JSON ({exc.msg} at line {exc.lineno})"]
        ) from exc
    if not isinstance(parsed, dict):
        raise RulesValidationError([f"$: {path.name} must hold a JSON object"])
    return parsed


def _check_against_schema(document: Mapping[str, Any], schema: Mapping[str, Any]) -> None:
    """Validate ``document`` against ``schema``, reporting every error in a stable order.

    The schema's identity is checked here; its own validity against the 2020-12 metaschema is a
    CI-time guarantee (a test), because the metaschema check costs ~0.2-0.5 s per call and
    ``shared/risk-rules.schema.json`` only changes through a reviewed, tested commit.
    """
    schema_id = schema.get("$id")
    if schema_id != RULES_SCHEMA_ID:
        raise RulesValidationError(
            [f"$: {schema_id!r} is not the Haulcast risk-rules schema {RULES_SCHEMA_ID!r}"]
        )
    errors = sorted(
        f"{'/'.join(str(part) for part in error.absolute_path) or '$'}: {error.message}"
        for error in Draft202012Validator(schema).iter_errors(document)
    )
    if errors:
        raise RulesValidationError(errors)


def _scale(step: float) -> int:
    """Return the number of ``step``s per unit; the schema restricts steps to powers of ten."""
    return round(1 / step)


def _on_grid(value: float, scale: int) -> bool:
    return abs(value * scale - round(value * scale)) <= _GRID_TOLERANCE


def _lower(band: Mapping[str, Any]) -> tuple[float, bool]:
    """Return a bounded band's lower threshold and whether the band includes it."""
    if "min_inclusive" in band:
        return band["min_inclusive"], True
    return band["min_exclusive"], False


def _upper(band: Mapping[str, Any]) -> tuple[float, bool]:
    """Return a bounded band's upper threshold and whether the band includes it."""
    if "max_inclusive" in band:
        return band["max_inclusive"], True
    return band["max_exclusive"], False


def _parse_factor(factor: Factor, spec: Mapping[str, Any], problems: list[str]) -> FactorRules:
    precision = spec["precision"]
    scale = _scale(precision)
    where = f"factors.{factor.value}.bands"
    bands: Sequence[Mapping[str, Any]] = spec["bands"]
    problems.extend(
        f"{where}.{band['level']}: threshold {band[key]} is not a multiple of the precision "
        f"{precision}"
        for band in bands
        for key in ("min_inclusive", "min_exclusive", "max_inclusive", "max_exclusive")
        if key in band and not _on_grid(band[key], scale)
    )
    for band in bands[1:-1]:
        (low, _), (high, _) = _lower(band), _upper(band)
        if round(low * scale) >= round(high * scale):
            problems.append(
                f"{where}.{band['level']}: lower bound {low} must be below upper bound {high}"
            )
    starts: list[int] = []
    for below, above in pairwise(bands):
        (top, top_included), (bottom, bottom_included) = _upper(below), _lower(above)
        if round(top * scale) != round(bottom * scale) or top_included == bottom_included:
            problems.append(
                f"{where}: {below['level']} and {above['level']} must meet at one threshold, "
                "exactly one of them including it"
            )
        start = round(bottom * scale)
        starts.append(start if bottom_included else start + 1)
    return FactorRules(
        factor=factor,
        label=spec["label"],
        unit=spec["unit"],
        precision=precision,
        scale=scale,
        decimals=len(str(scale)) - 1,
        band_starts=tuple(starts),
    )


def _parse_load_rules(
    specs: Sequence[Mapping[str, Any]],
    wind: FactorRules,
    load_limits: tuple[int, int],
    problems: list[str],
) -> tuple[LoadRule, ...]:
    ids = [spec["id"] for spec in specs]
    problems.extend(
        f"load_rules: duplicate id {rule_id}"
        for index, rule_id in enumerate(ids)
        if rule_id in ids[:index]
    )
    parsed = (_parse_load_rule(spec, wind, load_limits, problems) for spec in specs)
    rules = [rule for rule in parsed if rule is not None]
    ordered = sorted(
        rules, key=lambda r: (r.wind_min_q, math.inf if r.wind_max_q is None else r.wind_max_q)
    )
    problems.extend(
        f"load_rules: {first.rule_id} and {second.rule_id} overlap"
        for first, second in pairwise(ordered)
        if first.wind_max_q is None or first.wind_max_q > second.wind_min_q
    )
    return tuple(rules)


def _parse_load_rule(
    spec: Mapping[str, Any],
    wind: FactorRules,
    load_limits: tuple[int, int],
    problems: list[str],
) -> LoadRule | None:
    """Parse one load rule; return ``None`` when its wind range cannot be interpreted."""
    where = f"load_rules.{spec['id']}"
    load_min, load_max = load_limits
    threshold: int | None = spec["load_lb_min_exclusive"]
    if threshold is not None and not load_min <= threshold < load_max:
        problems.append(f"{where}: load threshold {threshold} must lie in [{load_min}, {load_max})")
    bounds = [spec["min_inclusive"], *([spec["max_exclusive"]] if "max_exclusive" in spec else [])]
    off_grid = [value for value in bounds if not _on_grid(value, wind.scale)]
    problems.extend(
        f"{where}: threshold {value} is not a multiple of the precision {wind.precision}"
        for value in off_grid
    )
    if off_grid:
        return None
    rule = LoadRule(
        rule_id=spec["id"],
        wind_min_q=wind.quantize(bounds[0]),
        wind_max_q=wind.quantize(bounds[1]) if len(bounds) > 1 else None,
        load_lb_above=threshold,
        result=RiskLevel.from_id(spec["result"]),
    )
    if rule.wind_max_q is not None and rule.wind_max_q <= rule.wind_min_q:
        problems.append(f"{where}: wind range is empty")
        return None
    band = wind.level_of(rule.wind_min_q)
    top = RiskLevel.NO_TRAVEL if rule.wind_max_q is None else wind.level_of(rule.wind_max_q - 1)
    if band != top:
        problems.append(f"{where}: wind range must lie inside one wind band")
    elif rule.result < band:
        problems.append(
            f"{where}: result {rule.result.id} is below the {band.id} wind band it applies to"
        )
    return rule
