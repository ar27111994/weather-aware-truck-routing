"""Classification and assessment (DOMAIN-CONTRACT 2-4): boundary tables, load rules, reasons."""

import dataclasses
import math
from itertools import pairwise
from typing import cast

import pytest

from haulcast.domain import (
    Assessment,
    Factor,
    InvalidLoadError,
    RiskLevel,
    WindMetric,
    assess,
    classify,
    load_rules,
)

from .support import RULES, rules_document, rules_schema, weather

WIND, RAIN, SNOW = Factor.WIND, Factor.RAIN, Factor.SNOW
LOW, MODERATE, HIGH = RiskLevel.LOW, RiskLevel.MODERATE, RiskLevel.HIGH
SEVERE, NO_TRAVEL = RiskLevel.SEVERE, RiskLevel.NO_TRAVEL

# Hand-written from the brief's Risk Rules table and DOMAIN-CONTRACT section 10: one step below,
# exactly at, and one step above every band edge. Severe's top edge for rain and snow is inclusive
# ("No Travel > 1.00 / > 3.0"); every other edge belongs to the band above it (D-01).
BRIEF_TABLE: list[tuple[Factor, float, RiskLevel]] = [
    (WIND, 24.9, LOW), (WIND, 25.0, MODERATE), (WIND, 25.1, MODERATE),
    (WIND, 34.9, MODERATE), (WIND, 35.0, HIGH), (WIND, 35.1, HIGH),
    (WIND, 44.9, HIGH), (WIND, 45.0, SEVERE), (WIND, 45.1, SEVERE),
    (WIND, 54.9, SEVERE), (WIND, 55.0, NO_TRAVEL), (WIND, 55.1, NO_TRAVEL),
    (RAIN, 0.099, LOW), (RAIN, 0.100, MODERATE), (RAIN, 0.101, MODERATE),
    (RAIN, 0.249, MODERATE), (RAIN, 0.250, HIGH), (RAIN, 0.251, HIGH),
    (RAIN, 0.499, HIGH), (RAIN, 0.500, SEVERE), (RAIN, 0.501, SEVERE),
    (RAIN, 0.999, SEVERE), (RAIN, 1.000, SEVERE), (RAIN, 1.001, NO_TRAVEL),
    (SNOW, 0.499, LOW), (SNOW, 0.500, MODERATE), (SNOW, 0.501, MODERATE),
    (SNOW, 0.999, MODERATE), (SNOW, 1.000, HIGH), (SNOW, 1.001, HIGH),
    (SNOW, 1.999, HIGH), (SNOW, 2.000, SEVERE), (SNOW, 2.001, SEVERE),
    (SNOW, 2.999, SEVERE), (SNOW, 3.000, SEVERE), (SNOW, 3.001, NO_TRAVEL),
]  # fmt: skip


def _generated_table() -> list[tuple[Factor, float, RiskLevel]]:
    """Derive the same edge cases from the raw rules file (not from the parsed rules)."""
    rows: list[tuple[Factor, float, RiskLevel]] = []
    for factor in Factor:
        spec = rules_document()["factors"][factor.value]
        step = spec["precision"]
        for below, above in pairwise(spec["bands"]):
            inclusive = "min_inclusive" in above
            edge = above["min_inclusive"] if inclusive else above["min_exclusive"]
            low, high = RiskLevel.from_id(below["level"]), RiskLevel.from_id(above["level"])
            rows.append((factor, round(edge - step, 6), low))
            rows.append((factor, round(edge, 6), high if inclusive else low))
            rows.append((factor, round(edge + step, 6), high))
    return rows


GENERATED_TABLE = _generated_table()


def _case_id(row: tuple[Factor, float, RiskLevel]) -> str:
    return f"{row[0].value}-{row[1]}-{row[2].id}"


def test_the_rules_file_agrees_with_the_brief() -> None:
    """Spec conformance: the table derived from the data equals the one copied from the brief."""
    assert sorted(GENERATED_TABLE) == sorted(BRIEF_TABLE)


@pytest.mark.parametrize("row", BRIEF_TABLE, ids=_case_id)
def test_brief_boundary_table(row: tuple[Factor, float, RiskLevel]) -> None:
    factor, value, expected = row
    assert classify(factor, value, RULES) is expected


@pytest.mark.parametrize("row", GENERATED_TABLE, ids=_case_id)
def test_generated_boundary_table(row: tuple[Factor, float, RiskLevel]) -> None:
    factor, value, expected = row
    assert classify(factor, value, RULES) is expected


@pytest.mark.parametrize(
    ("factor", "value", "expected"),
    [
        (RAIN, 0.1 - 1e-12, MODERATE),
        (RAIN, 0.09999999999, MODERATE),
        (RAIN, 0.30000000000000004, HIGH),
        (SNOW, 0.30000000000000004, LOW),
        (WIND, 25 - 1e-9, MODERATE),
        (WIND, 54.99999999, NO_TRAVEL),
        (RAIN, 1.0000000001, SEVERE),
        (SNOW, 3.0004, SEVERE),
        (WIND, 0.0, LOW),
        (RAIN, 0.0, LOW),
        (SNOW, -0.0, LOW),
        (WIND, 250.0, NO_TRAVEL),
        (RAIN, 12.0, NO_TRAVEL),
        (SNOW, 40.0, NO_TRAVEL),
    ],
)
def test_float_artifacts_and_extremes(factor: Factor, value: float, expected: RiskLevel) -> None:
    assert classify(factor, value, RULES) is expected


@pytest.mark.parametrize("value", [None, math.nan, math.inf, -math.inf, -0.1, -1e-9])
@pytest.mark.parametrize("factor", list(Factor))
def test_missing_or_invalid_values_are_unknown(factor: Factor, value: float | None) -> None:
    assert classify(factor, value, RULES) is None


def test_changing_a_threshold_in_the_file_changes_classification() -> None:
    document = rules_document()
    bands = document["factors"]["wind"]["bands"]
    bands[0]["max_exclusive"] = 30
    bands[1]["min_inclusive"] = 30
    stricter = load_rules(document, rules_schema())

    assert classify(WIND, 27.0, RULES) is MODERATE
    assert classify(WIND, 27.0, stricter) is LOW


# --------------------------------------------------------------------------- load rules (LR-1..3)

WINDS = (34.9, 35.0, 44.9, 45.0, 54.9, 55.0)
LOADS = (0, 30000, 30001, 40000, 40001, 80000)

# (wind, load) -> (final level, fired rule); hand-written from the brief's Load rules.
LOAD_TABLE: dict[tuple[float, int], tuple[RiskLevel, str | None]] = {
    **{(34.9, load): (MODERATE, None) for load in LOADS},
    **{(wind, load): (HIGH, None) for wind in (35.0, 44.9) for load in (0, 30000, 30001, 40000)},
    **{(wind, load): (SEVERE, "LR-3") for wind in (35.0, 44.9) for load in (40001, 80000)},
    **{(wind, load): (SEVERE, None) for wind in (45.0, 54.9) for load in (0, 30000)},
    **{
        (wind, load): (NO_TRAVEL, "LR-2")
        for wind in (45.0, 54.9)
        for load in (30001, 40000, 40001, 80000)
    },
    **{(55.0, load): (NO_TRAVEL, "LR-1") for load in LOADS},
}


@pytest.mark.parametrize(("wind", "load"), sorted(LOAD_TABLE), ids=str)
def test_load_rule_edges(wind: float, load: int) -> None:
    expected_level, expected_rule = LOAD_TABLE[(wind, load)]

    result = assess(weather(wind=wind), load, RULES)

    assert (result.level, result.load_rule) == (expected_level, expected_rule)
    assert result.factors[WIND] is classify(WIND, wind, RULES)


def test_load_table_covers_the_contract_grid() -> None:
    assert len(LOAD_TABLE) == len(WINDS) * len(LOADS)


@pytest.mark.parametrize("load", [-1, 80001, 30000.5, "30000", True, None])
def test_invalid_loads_raise(load: object) -> None:
    with pytest.raises(InvalidLoadError, match="load"):
        assess(weather(), cast("int", load), RULES)


def test_a_fired_rule_never_lowers_the_level() -> None:
    result = assess(weather(wind=40.0, rain=1.5), 45000, RULES)

    assert result.load_rule == "LR-3"
    assert result.level is NO_TRAVEL


# --------------------------------------------------------------------------- assessment + reasons


def test_calm_assessment_explains_every_factor() -> None:
    result = assess(weather(wind=12.3, gust=21.04, rain=0.0, snow=0.0), 38000, RULES)

    assert result == Assessment(
        level=LOW,
        factors={WIND: LOW, RAIN: LOW, SNOW: LOW},
        load_rule=None,
        incomplete=False,
        reasons=(
            "Wind 12.3 mph (Low); gusts 21.0 mph",
            "Rain 0.000 in/hr (Low)",
            "Snow 0.000 in/hr (Low)",
        ),
        warnings=(),
    )


def test_load_escalation_reason_follows_the_wind_line() -> None:
    result = assess(weather(wind=47.0, rain=0.3), 38000, RULES)

    assert result.level is NO_TRAVEL
    assert result.load_rule == "LR-2"
    assert result.reasons == (
        "Wind 47.0 mph (Severe)",
        "Load 38,000 lb is above 30,000 lb with wind 47.0 mph: No Travel (LR-2)",
        "Rain 0.300 in/hr (High)",
        "Snow 0.000 in/hr (Low)",
    )


def test_lr1_reason_applies_to_any_load() -> None:
    result = assess(weather(wind=55.04), 0, RULES)

    assert result.reasons[:2] == (
        "Wind 55.0 mph (No Travel)",
        "Wind 55.0 mph: No Travel for any load (LR-1)",
    )


def test_reasons_lead_with_the_factor_that_sets_the_level() -> None:
    result = assess(weather(wind=40.0, rain=0.12, snow=2.4), 45000, RULES)

    assert result.level is SEVERE
    assert result.reasons == (
        "Wind 40.0 mph (High)",
        "Load 45,000 lb is above 40,000 lb with wind 40.0 mph: Severe (LR-3)",
        "Snow 2.400 in/hr (Severe)",
        "Rain 0.120 in/hr (Moderate)",
    )


def test_partial_data_is_incomplete_and_named() -> None:
    result = assess(weather(wind=30.0, rain=None, snow=None), 1000, RULES)

    assert result.level is MODERATE
    assert result.incomplete is True
    assert result.factors == {WIND: MODERATE, RAIN: None, SNOW: None}
    assert result.reasons[-2:] == ("Rain data unavailable", "Snow data unavailable")
    assert result.warnings == ()


def test_all_unknown_is_unknown_not_low() -> None:
    result = assess(weather(wind=None, rain=None, snow=None), 1000, RULES)

    assert result.level is None
    assert result.incomplete is True
    assert result.load_rule is None
    assert result.reasons == (
        "Wind data unavailable",
        "Rain data unavailable",
        "Snow data unavailable",
    )


@pytest.mark.parametrize("bad", [math.nan, -0.5, math.inf])
def test_invalid_inputs_are_unknown_with_a_warning(bad: float) -> None:
    result = assess(weather(wind=10.0, rain=bad), 1000, RULES)

    assert result.factors[RAIN] is None
    assert result.level is LOW
    assert result.incomplete is True
    assert "Rain data invalid" in result.reasons
    assert result.warnings == (f"Invalid rain value {bad!r} from the weather provider was ignored",)


def test_an_invalid_gust_is_reported_even_when_gusts_do_not_classify() -> None:
    result = assess(weather(wind=10.0, gust=-3.0), 1000, RULES)

    assert result.factors[WIND] is LOW
    assert result.reasons[0] == "Wind 10.0 mph (Low)"
    assert result.warnings == (
        "Invalid wind gust value -3.0 from the weather provider was ignored",
    )


# --------------------------------------------------------------------------- the wind-metric switch


@pytest.mark.parametrize(
    ("metric", "wind", "gust", "level", "reason"),
    [
        (WindMetric.SUSTAINED, 20.0, 50.0, LOW, "Wind 20.0 mph (Low); gusts 50.0 mph"),
        (WindMetric.SUSTAINED, 20.0, None, LOW, "Wind 20.0 mph (Low)"),
        (WindMetric.GUST, 20.0, 50.0, SEVERE, "Wind gusts 50.0 mph (Severe); sustained 20.0 mph"),
        (WindMetric.GUST, None, 50.0, SEVERE, "Wind gusts 50.0 mph (Severe)"),
        (
            WindMetric.MAX,
            20.0,
            50.0,
            SEVERE,
            "Wind 50.0 mph (Severe), the higher of sustained 20.0 mph and gusts 50.0 mph",
        ),
        (
            WindMetric.MAX,
            36.0,
            None,
            HIGH,
            "Wind 36.0 mph (High), the higher of sustained 36.0 mph and gusts unavailable",
        ),
        (
            WindMetric.MAX,
            None,
            26.0,
            MODERATE,
            "Wind 26.0 mph (Moderate), the higher of sustained unavailable and gusts 26.0 mph",
        ),
    ],
)
def test_every_wind_metric_classifies(
    metric: WindMetric, wind: float | None, gust: float | None, level: RiskLevel, reason: str
) -> None:
    rules = dataclasses.replace(RULES, wind_metric=metric)

    result = assess(weather(wind=wind, gust=gust), 1000, rules)

    assert result.factors[WIND] is level
    assert result.reasons[0] == reason


@pytest.mark.parametrize(
    ("metric", "wind", "gust", "reason"),
    [
        (WindMetric.SUSTAINED, None, 50.0, "Wind data unavailable"),
        (WindMetric.GUST, 20.0, None, "Wind data unavailable"),
        (WindMetric.MAX, None, None, "Wind data unavailable"),
        (WindMetric.GUST, 20.0, math.nan, "Wind data invalid"),
        (WindMetric.MAX, 20.0, math.nan, "Wind data invalid"),
    ],
)
def test_wind_metric_inputs_missing_or_invalid(
    metric: WindMetric, wind: float | None, gust: float | None, reason: str
) -> None:
    rules = dataclasses.replace(RULES, wind_metric=metric)

    result = assess(weather(wind=wind, gust=gust), 1000, rules)

    assert result.factors[WIND] is None
    assert reason in result.reasons


def test_load_rules_use_the_metric_wind_value() -> None:
    gusty = dataclasses.replace(RULES, wind_metric=WindMetric.GUST)

    result = assess(weather(wind=20.0, gust=47.0), 38000, gusty)

    assert (result.level, result.load_rule) == (NO_TRAVEL, "LR-2")
    assert (
        result.reasons[1]
        == "Load 38,000 lb is above 30,000 lb with wind 47.0 mph: No Travel (LR-2)"
    )


def test_assessments_are_immutable() -> None:
    result = assess(weather(), 0, RULES)
    factors = cast("dict[Factor, object]", result.factors)

    with pytest.raises(TypeError):
        factors[WIND] = None
    field = "level"
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(result, field, None)
