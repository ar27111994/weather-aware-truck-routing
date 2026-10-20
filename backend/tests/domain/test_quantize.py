"""Exact D-02 quantization: ``round_half_even(value * scale)`` on the value as written.

The product has to be rounded exactly. In binary floating point a value a hair below a half-step
multiplies out to exactly ``.5`` (``54.949999999999996 * 10 == 549.5``) and then rounds the wrong
way, so the exact value 54.9 mph (Severe) came out as 55.0 mph (No Travel, LR-1). Provider values
are written in decimal, so a value is read as its shortest decimal form, the way ``repr`` prints it.
"""

import math
from fractions import Fraction

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from haulcast.domain import Factor, RiskLevel, assess, classify
from haulcast.domain.quantize import quantize_exactly

from .oracle import EDGES, SCALE, oracle_level, quantized
from .support import RULES, weather

WIND, RAIN, SNOW = Factor.WIND, Factor.RAIN, Factor.SNOW
MODERATE, HIGH, SEVERE, NO_TRAVEL = (
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)

# (value, scale, expected steps), written by hand from "round half to even on the decimal value".
# A half-step lands on the even neighbour: 249.5 -> 250 but 250.5 -> 250; 123.5 -> 124 but
# 122.5 -> 122.
TIES: list[tuple[float, int, int]] = [
    # wind, tenths of a mph
    (24.95, 10, 250), (25.05, 10, 250), (34.85, 10, 348), (34.95, 10, 350),
    (44.95, 10, 450), (45.05, 10, 450), (54.85, 10, 548), (54.95, 10, 550),
    # rain and snow, thousandths of an inch
    (0.0995, 1000, 100), (0.1005, 1000, 100), (0.2495, 1000, 250), (0.2505, 1000, 250),
    (0.4995, 1000, 500), (0.5005, 1000, 500), (0.9995, 1000, 1000), (1.0005, 1000, 1000),
    (1.0015, 1000, 1002), (1.9995, 1000, 2000), (2.9995, 1000, 3000), (3.0005, 1000, 3000),
    (3.0015, 1000, 3002),
    # ranking tolerances: miles to 0.1, average risk to 0.001, whole seconds
    (0.05, 10, 0), (0.15, 10, 2), (0.25, 10, 2), (0.35, 10, 4), (12.25, 10, 122), (12.35, 10, 124),
    (0.0005, 1000, 0), (0.0015, 1000, 2), (0.2985, 1000, 298), (0.2995, 1000, 300),
    (0.5, 1, 0), (1.5, 1, 2), (2.5, 1, 2), (3.5, 1, 4), (3600.5, 1, 3600), (3601.5, 1, 3602),
    # a half-step in negative numbers rounds to the even neighbour too
    (-2.5, 1, -2), (-3.5, 1, -4), (-24.95, 10, -250), (-25.05, 10, -250),
    # the decimal value is exactly a tie, but the float product lands one step off it: above with
    # an even floor (54.500000000000007 -> 54, not 55), below with an odd floor (57.499999999999993
    # -> 58, not 57)
    (0.545, 100, 54), (1.225, 100, 122), (0.575, 100, 58), (1.015, 100, 102),
    (2.0005, 1000, 2000), (0.5015, 1000, 502), (4540.685, 100, 454068),
]  # fmt: skip

# The two inputs of T9's oracle that the float product got wrong: each is the double one step
# below a half-step tie, whose exact value is below the tie.
ARTIFACTS: list[tuple[float, int, int]] = [
    (54.949999999999996, 10, 549),
    (0.9994999999999999, 1000, 999),
]


@pytest.mark.parametrize(("value", "scale", "expected"), TIES)
def test_a_half_step_tie_rounds_to_the_even_step(value: float, scale: int, expected: int) -> None:
    assert quantize_exactly(value, scale) == expected


@pytest.mark.parametrize(("value", "scale", "expected"), ARTIFACTS)
def test_a_value_just_below_a_tie_is_not_rounded_up_by_float_noise(
    value: float, scale: int, expected: int
) -> None:
    assert value * scale == expected + 0.5  # the float product is exactly the tie: the artifact
    assert quantize_exactly(value, scale) == expected


def test_the_artifacts_are_the_doubles_one_step_below_the_ties() -> None:
    assert math.nextafter(54.95, 0.0) == 54.949999999999996
    assert math.nextafter(0.9995, 0.0) == 0.9994999999999999


@pytest.mark.parametrize(
    ("value", "scale", "expected"),
    [(math.nextafter(54.95, 99.0), 10, 550), (math.nextafter(0.9995, 9.0), 1000, 1000)],
    ids=["wind", "snow"],
)
def test_a_value_just_above_a_tie_rounds_up(value: float, scale: int, expected: int) -> None:
    assert quantize_exactly(value, scale) == expected


def test_the_wind_artifact_is_severe_without_a_load_rule_not_no_travel() -> None:
    sample = weather(wind=54.949999999999996)

    assessment = assess(sample, 20_000, RULES)

    assert classify(WIND, 54.949999999999996, RULES) is SEVERE
    assert (assessment.level, assessment.load_rule) == (SEVERE, None)
    assert "Wind 54.9 mph (Severe)" in assessment.reasons[0]


def test_the_snow_artifact_is_moderate_not_high() -> None:
    assert classify(SNOW, 0.9994999999999999, RULES) is MODERATE
    assert classify(RAIN, 0.9994999999999999, RULES) is SEVERE  # rain 0.999 is Severe either way


def test_the_factor_rules_quantize_through_the_exact_function() -> None:
    assert RULES.factors[WIND].quantize(54.949999999999996) == 549
    assert RULES.factors[SNOW].quantize(0.9994999999999999) == 999
    assert RULES.factors[WIND].quantize(24.95) == 250


@pytest.mark.parametrize("value", [1e15, 1e300, 2.0**60, 1.7976931348623157e308, 5e-324, 0.0, -0.0])
@pytest.mark.parametrize("scale", [1, 10, 1000])
def test_values_beyond_the_float_fast_path_are_exact_too(value: float, scale: int) -> None:
    assert quantize_exactly(value, scale) == quantized(value, scale)


def test_a_product_that_overflows_a_float_is_still_exact() -> None:
    assert math.isinf(1.7976931348623157e308 * 1000)
    assert quantize_exactly(1.7976931348623157e308, 1000) == 17976931348623157 * 10**295


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_values_that_are_not_numbers_are_refused(value: float) -> None:
    with pytest.raises(ValueError, match="not a finite number"):
        quantize_exactly(value, 10)


def test_whole_numbers_pass_through() -> None:
    assert quantize_exactly(250, 10) == 2500  # an int is a valid value too


SCALES = st.sampled_from([1, 10, 100, 1000, 10_000])
magnitudes = st.one_of(
    st.floats(min_value=0.0, max_value=1_000.0, allow_nan=False),
    st.floats(min_value=0.0, max_value=1e7, allow_nan=False),
)


@st.composite
def near_ties(draw: st.DrawFn) -> tuple[float, int]:
    """A float within three steps of an exact half-step tie, below or above it."""
    scale = draw(SCALES)
    whole = draw(st.integers(min_value=0, max_value=2_000_000))
    value = float(Fraction(2 * whole + 1, 2 * scale))
    for _ in range(draw(st.integers(min_value=0, max_value=3))):
        value = math.nextafter(value, math.inf if draw(st.booleans()) else -math.inf)
    return value, scale


@given(case=st.one_of(near_ties(), st.tuples(magnitudes, SCALES)))
@example(case=(54.949999999999996, 10))
@example(case=(0.9994999999999999, 1000))
@example(case=(0.545, 100))
@example(case=(0.575, 100))
def test_quantization_equals_exact_arithmetic(case: tuple[float, int]) -> None:
    value, scale = case
    assert quantize_exactly(value, scale) == quantized(value, scale)


@pytest.mark.parametrize("offset", [2.0**-14, 2.0**-12, 2.0**-11, 2.0**-10, 2.0**-9, 1e-6, 1e-3])
@pytest.mark.parametrize("scale", [10, 1000])
@pytest.mark.parametrize("whole", [0, 1, 249, 549, 999, 2_999, 1_000_003])
def test_the_exact_path_takes_over_exactly_where_the_float_product_is_unsafe(
    whole: int, scale: int, offset: float
) -> None:
    """Probe both sides of the guard band around a tie, at several magnitudes."""
    for sign in (-1, 1):
        value = (whole + 0.5 + sign * offset) / scale
        assert quantize_exactly(value, scale) == quantized(value, scale)


@st.composite
def edge_values(draw: st.DrawFn) -> tuple[Factor, float]:
    """A factor value within a few floats of a half-step next to one of the brief's band edges."""
    factor = draw(st.sampled_from(list(Factor)))
    edge = draw(st.sampled_from(EDGES[factor]))
    halves = draw(st.integers(min_value=-3, max_value=3))
    value = max(float(edge + Fraction(halves, 2 * SCALE[factor])), 0.0)
    for _ in range(draw(st.integers(min_value=0, max_value=3))):
        value = math.nextafter(value, math.inf if draw(st.booleans()) else -math.inf)
    return factor, max(value, 0.0)


@given(case=edge_values())
@example(case=(WIND, 54.949999999999996))
@example(case=(SNOW, 0.9994999999999999))
def test_classification_equals_the_briefs_table_on_exact_values(case: tuple[Factor, float]) -> None:
    factor, value = case
    assert classify(factor, value, RULES) is oracle_level(factor, value)


@given(factor=st.sampled_from(list(Factor)), value=st.floats(min_value=0.0, max_value=80.0))
def test_classification_equals_the_briefs_table_everywhere(factor: Factor, value: float) -> None:
    assert classify(factor, value, RULES) is oracle_level(factor, value)
