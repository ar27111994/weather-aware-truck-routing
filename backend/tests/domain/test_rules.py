"""Rules loading: JSON Schema validation, semantic invariants, parsing, the shared file."""

import dataclasses
import json
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from jsonschema import Draft202012Validator

from haulcast.domain import (
    RULES_SCHEMA_ID,
    Factor,
    RiskLevel,
    RiskRules,
    RulesValidationError,
    WindMetric,
    load_rules,
    load_rules_file,
)

from .support import REPO_ROOT, RULES, RULES_PATH, SCHEMA_PATH, rules_document, rules_schema

Mutation = Callable[[dict[str, Any]], None]


def _invalid(mutate: Mutation) -> RulesValidationError:
    document = rules_document()
    mutate(document)
    with pytest.raises(RulesValidationError) as caught:
        load_rules(document, rules_schema())
    return caught.value


# --------------------------------------------------------------------------- the shared file


def test_shared_rules_file_parses_into_typed_rules() -> None:
    rules = load_rules_file(RULES_PATH)

    assert rules == RULES
    assert rules.version == "1.0.0"
    assert rules.wind_metric is WindMetric.SUSTAINED
    assert rules.level_labels[RiskLevel.NO_TRAVEL] == "No Travel"
    assert [rules.factors[f].label for f in Factor] == ["Wind", "Rain", "Snow"]
    assert [rules.factors[f].unit for f in Factor] == ["mph", "in/hr", "in/hr"]
    assert [rules.factors[f].scale for f in Factor] == [10, 1000, 1000]
    assert [rules.factors[f].decimals for f in Factor] == [1, 3, 3]
    # First quantized value of each band above Low (D-01 boundary convention, D-02 quantization).
    assert rules.factors[Factor.WIND].band_starts == (250, 350, 450, 550)
    assert rules.factors[Factor.RAIN].band_starts == (100, 250, 500, 1001)
    assert rules.factors[Factor.SNOW].band_starts == (500, 1000, 2000, 3001)
    assert [
        (r.rule_id, r.wind_min_q, r.wind_max_q, r.load_lb_above, r.result) for r in rules.load_rules
    ] == [
        ("LR-1", 550, None, None, RiskLevel.NO_TRAVEL),
        ("LR-2", 450, 550, 30000, RiskLevel.NO_TRAVEL),
        ("LR-3", 350, 450, 40000, RiskLevel.SEVERE),
    ]
    assert (rules.load_min_lb, rules.load_max_lb, rules.assumed_tare_lb) == (0, 80000, 35000)
    assert rules.sampling_intervals_mi == (10, 25, 50)
    assert rules.default_sampling_interval_mi == 25
    assert (
        rules.ranking.miles_scale,
        rules.ranking.avg_risk_scale,
        rules.ranking.duration_scale,
    ) == (
        10,
        1000,
        1,
    )


def test_load_rules_file_reads_the_sibling_schema_or_an_explicit_one(tmp_path: Path) -> None:
    (tmp_path / "risk-rules.json").write_text(
        RULES_PATH.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / "risk-rules.schema.json").write_text(
        SCHEMA_PATH.read_text(encoding="utf-8"), encoding="utf-8"
    )

    assert load_rules_file(tmp_path / "risk-rules.json") == RULES
    assert load_rules_file(RULES_PATH, schema_path=SCHEMA_PATH) == RULES


def test_load_rules_file_rejects_malformed_json(tmp_path: Path) -> None:
    broken = tmp_path / "risk-rules.json"
    broken.write_text("{not json", encoding="utf-8")

    with pytest.raises(RulesValidationError, match="not valid JSON"):
        load_rules_file(broken, schema_path=SCHEMA_PATH)


def test_load_rules_file_rejects_json_that_is_not_an_object(tmp_path: Path) -> None:
    listed = tmp_path / "risk-rules.json"
    listed.write_text("[1, 2]", encoding="utf-8")

    with pytest.raises(RulesValidationError, match="must hold a JSON object"):
        load_rules_file(listed, schema_path=SCHEMA_PATH)


def test_load_rules_file_lets_a_missing_file_surface_as_an_os_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_rules_file(tmp_path / "absent.json", schema_path=SCHEMA_PATH)


def test_schema_is_a_valid_json_schema_2020_12_document() -> None:
    schema = rules_schema()

    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"] == RULES_SCHEMA_ID
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(rules_document())


def test_a_schema_with_another_id_is_refused() -> None:
    schema = rules_schema()
    schema["$id"] = "urn:example:other"

    with pytest.raises(RulesValidationError, match="not the Haulcast risk-rules schema"):
        load_rules(rules_document(), schema)


_SKIPPED_DIRS = frozenset({"node_modules", ".git", ".planning", ".local", ".venv", "build", "dist"})
_JSON_IMPORT = re.compile(r"""from\s+["']([^"']*risk-rules\.json)["']""")


def _repo_files() -> list[Path]:
    found: list[Path] = []
    for directory, subdirectories, files in os.walk(REPO_ROOT):
        subdirectories[:] = [name for name in subdirectories if name not in _SKIPPED_DIRS]
        found.extend(Path(directory, name) for name in files)
    return found


def test_the_backend_and_frontend_share_one_rules_file() -> None:
    """Single source of truth (DOMAIN-CONTRACT section 2).

    The repository holds exactly one rules file and one schema, both in ``shared/``; the backend
    reads that file (above), and every frontend import of it must resolve to the very same path.
    """
    files = _repo_files()

    assert [p.resolve() for p in files if p.name == "risk-rules.json"] == [RULES_PATH.resolve()]
    assert [p.resolve() for p in files if p.name == "risk-rules.schema.json"] == [
        SCHEMA_PATH.resolve()
    ]
    frontend_sources = [p for p in files if "frontend" in p.parts and p.suffix in {".ts", ".tsx"}]
    for source in frontend_sources:
        for imported in _JSON_IMPORT.findall(source.read_text(encoding="utf-8")):
            assert (source.parent / imported).resolve() == RULES_PATH.resolve(), (source, imported)


@pytest.mark.parametrize(
    ("field", "value"), [("version", "2.0.0"), ("wind_metric", WindMetric.GUST)]
)
def test_parsed_rules_are_immutable(field: str, value: object) -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(RULES, field, value)
    # Bypass the read-only static type on purpose: the mapping must refuse writes at runtime too.
    factors = cast("dict[Factor, object]", RULES.factors)
    with pytest.raises(TypeError):
        factors[Factor.WIND] = None


# --------------------------------------------------------------------------- JSON Schema failures


def _drop_band(document: dict[str, Any]) -> None:
    del document["factors"]["snow"]["bands"][3]


def _swap_bands(document: dict[str, Any]) -> None:
    bands = document["factors"]["rain"]["bands"]
    bands[1], bands[2] = bands[2], bands[1]


def _extra_band(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"].append({"level": "no_travel", "min_inclusive": 99})


def _unknown_metric(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["metric"] = "peak"


def _metric_on_rain(document: dict[str, Any]) -> None:
    document["factors"]["rain"]["metric"] = "sustained"


def _missing_factor(document: dict[str, Any]) -> None:
    del document["factors"]["snow"]


def _renamed_level(document: dict[str, Any]) -> None:
    document["levels"][4]["id"] = "extreme"


def _reordered_ranking_keys(document: dict[str, Any]) -> None:
    keys = document["ranking"]["keys"]
    keys[0], keys[1] = keys[1], keys[0]


def _negative_threshold(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"][0]["max_exclusive"] = -25


def _two_lower_bounds(document: dict[str, Any]) -> None:
    document["factors"]["rain"]["bands"][4]["min_inclusive"] = 1.0


def _bounded_top_band(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"][4]["max_exclusive"] = 200


def _bounded_low_band(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"][0]["min_inclusive"] = 1


def _middle_band_without_upper(document: dict[str, Any]) -> None:
    del document["factors"]["wind"]["bands"][2]["max_exclusive"]


def _odd_precision(document: dict[str, Any]) -> None:
    document["factors"]["rain"]["precision"] = 0.005


def _fractional_load_threshold(document: dict[str, Any]) -> None:
    document["load_rules"][1]["load_lb_min_exclusive"] = 30000.5


def _load_rule_on_rain(document: dict[str, Any]) -> None:
    document["load_rules"][2]["factor"] = "rain"


def _duplicate_interval(document: dict[str, Any]) -> None:
    document["sampling_intervals_mi"] = [10, 25, 25]


def _unknown_top_level_key(document: dict[str, Any]) -> None:
    document["thresholds"] = {}


def _wrong_unit(document: dict[str, Any]) -> None:
    document["units"]["wind"] = "km/h"


@pytest.mark.parametrize(
    ("mutate", "path_fragment"),
    [
        pytest.param(_drop_band, "factors/snow/bands", id="missing-band"),
        pytest.param(_swap_bands, "factors/rain/bands/1", id="bands-out-of-level-order"),
        pytest.param(_extra_band, "factors/wind/bands", id="sixth-band"),
        pytest.param(_unknown_metric, "factors/wind/metric", id="unknown-wind-metric"),
        pytest.param(_metric_on_rain, "factors/rain", id="metric-on-rain"),
        pytest.param(_missing_factor, "factors", id="missing-factor"),
        pytest.param(_renamed_level, "levels/4/id", id="unknown-level-id"),
        pytest.param(_reordered_ranking_keys, "ranking/keys", id="ranking-keys-reordered"),
        pytest.param(_negative_threshold, "factors/wind/bands/0", id="negative-threshold"),
        pytest.param(_two_lower_bounds, "factors/rain/bands/4", id="two-lower-bounds"),
        pytest.param(_bounded_top_band, "factors/wind/bands/4", id="bounded-no-travel"),
        pytest.param(_bounded_low_band, "factors/wind/bands/0", id="bounded-low"),
        pytest.param(_middle_band_without_upper, "factors/wind/bands/2", id="open-middle-band"),
        pytest.param(_odd_precision, "factors/rain/precision", id="precision-not-power-of-ten"),
        pytest.param(_fractional_load_threshold, "load_rules/1", id="fractional-load"),
        pytest.param(_load_rule_on_rain, "load_rules/2/factor", id="load-rule-on-rain"),
        pytest.param(_duplicate_interval, "sampling_intervals_mi", id="duplicate-interval"),
        pytest.param(_unknown_top_level_key, "$", id="unknown-key"),
        pytest.param(_wrong_unit, "units/wind", id="wrong-unit"),
    ],
)
def test_schema_violations_raise_rules_validation_error(
    mutate: Mutation, path_fragment: str
) -> None:
    error = _invalid(mutate)

    assert error.errors, "a validation error must carry at least one message"
    assert any(message.startswith(path_fragment) for message in error.errors), error.errors
    assert str(error).startswith("risk rules are invalid: ")


def test_schema_errors_are_reported_in_a_stable_order() -> None:
    def two_problems(document: dict[str, Any]) -> None:
        document["units"]["wind"] = "km/h"
        document["factors"]["wind"]["metric"] = "peak"

    first = _invalid(two_problems).errors
    second = _invalid(two_problems).errors

    assert first == second
    assert len(first) == 2
    assert first == tuple(sorted(first))


# --------------------------------------------------------------------------- semantic invariants


def _gap(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"][1]["max_exclusive"] = 34


def _overlap(document: dict[str, Any]) -> None:
    document["factors"]["wind"]["bands"][1]["max_exclusive"] = 36


def _both_include_boundary(document: dict[str, Any]) -> None:
    band = document["factors"]["rain"]["bands"][1]
    del band["max_exclusive"]
    band["max_inclusive"] = 0.25


def _neither_includes_boundary(document: dict[str, Any]) -> None:
    band = document["factors"]["rain"]["bands"][2]
    del band["min_inclusive"]
    band["min_exclusive"] = 0.25


def _non_monotonic(document: dict[str, Any]) -> None:
    bands = document["factors"]["snow"]["bands"]
    bands[2]["max_exclusive"] = 0.75
    bands[3]["min_inclusive"] = 0.75


def _off_grid_threshold(document: dict[str, Any]) -> None:
    bands = document["factors"]["rain"]["bands"]
    bands[0]["max_exclusive"] = 0.1234
    bands[1]["min_inclusive"] = 0.1234


def _rule_straddles_bands(document: dict[str, Any]) -> None:
    document["load_rules"][2]["min_inclusive"] = 30


def _rule_lowers_level(document: dict[str, Any]) -> None:
    document["load_rules"][2]["result"] = "moderate"


def _rules_overlap(document: dict[str, Any]) -> None:
    document["load_rules"][1]["max_exclusive"] = 60


def _unbounded_rule_overlaps(document: dict[str, Any]) -> None:
    document["load_rules"][0]["min_inclusive"] = 45


def _empty_rule_range(document: dict[str, Any]) -> None:
    document["load_rules"][2]["max_exclusive"] = 35


def _off_grid_rule(document: dict[str, Any]) -> None:
    document["load_rules"][2]["min_inclusive"] = 35.05


def _duplicate_rule_id(document: dict[str, Any]) -> None:
    document["load_rules"][2]["id"] = "LR-2"


def _unreachable_load_threshold(document: dict[str, Any]) -> None:
    document["load_rules"][1]["load_lb_min_exclusive"] = 80000


def _inverted_load_limits(document: dict[str, Any]) -> None:
    document["load_limits_lb"] = {"min": 80000, "max": 1000}


def _unlisted_default_interval(document: dict[str, Any]) -> None:
    document["default_sampling_interval_mi"] = 30


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        pytest.param(_gap, "factors.wind.bands: moderate and high must meet", id="gap"),
        pytest.param(_overlap, "factors.wind.bands: moderate and high must meet", id="overlap"),
        pytest.param(
            _both_include_boundary,
            "factors.rain.bands: moderate and high must meet",
            id="both-inclusive",
        ),
        pytest.param(
            _neither_includes_boundary,
            "factors.rain.bands: moderate and high must meet",
            id="both-exclusive",
        ),
        pytest.param(
            _non_monotonic,
            "factors.snow.bands.high: lower bound 1.0 must be below",
            id="non-monotonic",
        ),
        pytest.param(
            _off_grid_threshold, "not a multiple of the precision 0.001", id="threshold-off-grid"
        ),
        pytest.param(
            _rule_straddles_bands, "load_rules.LR-3: wind range must lie inside one", id="straddle"
        ),
        pytest.param(
            _rule_lowers_level, "load_rules.LR-3: result moderate is below", id="lowers-level"
        ),
        pytest.param(_rules_overlap, "load_rules: LR-2 and LR-1 overlap", id="rules-overlap"),
        pytest.param(
            _unbounded_rule_overlaps, "load_rules: LR-2 and LR-1 overlap", id="unbounded-overlap"
        ),
        pytest.param(_empty_rule_range, "load_rules.LR-3: wind range is empty", id="empty-rule"),
        pytest.param(
            _off_grid_rule, "load_rules.LR-3: threshold 35.05 is not a multiple", id="rule-off-grid"
        ),
        pytest.param(_duplicate_rule_id, "load_rules: duplicate id LR-2", id="duplicate-id"),
        pytest.param(
            _unreachable_load_threshold, "load_rules.LR-2: load threshold 80000", id="dead-rule"
        ),
        pytest.param(
            _inverted_load_limits, "load_limits_lb: min 80000 must be below max 1000", id="limits"
        ),
        pytest.param(
            _unlisted_default_interval, "default_sampling_interval_mi: 30", id="default-interval"
        ),
    ],
)
def test_semantic_invariants_raise_rules_validation_error(mutate: Mutation, message: str) -> None:
    error = _invalid(mutate)

    assert any(message in line for line in error.errors), error.errors


def test_every_semantic_violation_is_reported_at_once() -> None:
    def three_problems(document: dict[str, Any]) -> None:
        _gap(document)
        _duplicate_rule_id(document)
        _unlisted_default_interval(document)

    assert len(_invalid(three_problems).errors) == 3


@pytest.mark.parametrize("metric", list(WindMetric))
def test_every_wind_metric_parses(metric: WindMetric) -> None:
    document = rules_document()
    document["factors"]["wind"]["metric"] = metric.value

    assert load_rules(document, rules_schema()).wind_metric is metric


def test_tolerances_and_precisions_become_integer_scales() -> None:
    document = rules_document()
    document["ranking"]["tolerances"] = {"miles": 0.01, "avg_risk": 0.1, "duration_s": 0.0001}
    document["factors"]["wind"]["precision"] = 1

    rules: RiskRules = load_rules(document, rules_schema())

    assert (
        rules.ranking.miles_scale,
        rules.ranking.avg_risk_scale,
        rules.ranking.duration_scale,
    ) == (
        100,
        10,
        10000,
    )
    assert rules.factors[Factor.WIND].scale == 1
    assert rules.factors[Factor.WIND].decimals == 0
    assert rules.factors[Factor.WIND].band_starts == (25, 35, 45, 55)


def test_rules_documents_round_trip_through_json() -> None:
    """The loader accepts exactly what ``json.load`` produces (no Python-only types needed)."""
    document = json.loads(json.dumps(rules_document()))

    assert load_rules(document, rules_schema()) == RULES
