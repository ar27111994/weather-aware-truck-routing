"""Hypothesis properties of classification and assessment (DOMAIN-CONTRACT section 10).

Every wind metric is exercised: raising any weather input or the load never lowers the level, a
load rule never lowers it either, and without a fired load rule the level is exactly the highest
known factor level.
"""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.domain import Factor, RiskRules, WindMetric, assess, classify, load_rules
from tests.domain.support import rules_document, rules_schema, weather


def rules_for(metric: WindMetric) -> RiskRules:
    document = rules_document()
    document["factors"]["wind"]["metric"] = metric.value
    return load_rules(document, rules_schema())


RULES_BY_METRIC = {metric: rules_for(metric) for metric in WindMetric}

speeds = st.floats(min_value=0.0, max_value=150.0)
VARIED = {
    "wind": speeds,
    "gust": speeds,
    "rain": st.floats(min_value=0.0, max_value=4.0),
    "snow": st.floats(min_value=0.0, max_value=10.0),
}
weather_inputs = st.fixed_dictionaries(VARIED)
metrics = st.sampled_from(list(WindMetric))
loads = st.integers(min_value=0, max_value=80_000)


@pytest.mark.parametrize("name", sorted(VARIED))
@given(data=st.data(), metric=metrics, inputs=weather_inputs, load=loads)
def test_raising_any_weather_input_never_lowers_the_level(
    name: str, data: st.DataObject, metric: WindMetric, inputs: dict[str, float], load: int
) -> None:
    low, high = sorted((data.draw(VARIED[name], label="a"), data.draw(VARIED[name], label="b")))
    rules = RULES_BY_METRIC[metric]

    calmer = assess(weather(**{**inputs, name: low}), load, rules)
    rougher = assess(weather(**{**inputs, name: high}), load, rules)

    assert calmer.level is not None
    assert rougher.level is not None
    assert calmer.level <= rougher.level


@given(metric=metrics, inputs=weather_inputs, a=loads, b=loads)
def test_a_heavier_load_never_lowers_the_level(
    metric: WindMetric, inputs: dict[str, float], a: int, b: int
) -> None:
    light, heavy = sorted((a, b))
    rules = RULES_BY_METRIC[metric]
    sample = weather(**inputs)

    lighter, heavier = assess(sample, light, rules), assess(sample, heavy, rules)

    assert lighter.level is not None
    assert heavier.level is not None
    assert lighter.level <= heavier.level


@given(metric=metrics, inputs=weather_inputs, load=loads)
def test_load_rules_only_ever_raise_the_level(
    metric: WindMetric, inputs: dict[str, float], load: int
) -> None:
    rules = RULES_BY_METRIC[metric]
    results = {rule.rule_id: rule.result for rule in rules.load_rules}

    assessment = assess(weather(**inputs), load, rules)

    base = max(level for level in assessment.factors.values() if level is not None)
    assert assessment.level is not None
    assert assessment.level >= base
    if assessment.load_rule is None:
        assert assessment.level == base
    else:
        assert assessment.factors[Factor.WIND] is not None
        assert assessment.level == max(base, results[assessment.load_rule])


@pytest.mark.parametrize("factor", list(Factor))
@given(data=st.data())
def test_classification_is_monotonic_in_each_factor(factor: Factor, data: st.DataObject) -> None:
    strategy = VARIED[factor.value]
    low, high = sorted((data.draw(strategy, label="a"), data.draw(strategy, label="b")))
    rules = RULES_BY_METRIC[WindMetric.SUSTAINED]

    calmer, rougher = classify(factor, low, rules), classify(factor, high, rules)

    assert calmer is not None
    assert rougher is not None
    assert calmer <= rougher
