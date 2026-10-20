"""Tests of the demo-scenario models, their JSON Schema and the scenario catalog."""

import json
import math
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from haulcast.config.paths import SHARED_DIR_VARIABLE, shared_dir
from haulcast.providers.weather.scenarios import (
    JSON_SCHEMA_DIALECT,
    MAX_CELLS,
    SCHEMA_FILE_NAME,
    ActiveWindow,
    Conditions,
    Motion,
    Scenario,
    ScenarioCatalog,
    ScenarioFileError,
    ScenarioSummary,
    StormCell,
    UnknownScenarioError,
    scenario_json_schema,
    write_json_schema,
)

SHIPPED_DIR = shared_dir() / "scenarios"
SHIPPED_FILES = sorted(path for path in SHIPPED_DIR.glob("*.json") if path.name != SCHEMA_FILE_NAME)
SHIPPED_IDS = ["calm", "storm-on-fastest", "high-wind-corridor", "gulf-downpour"]
Location = tuple[int | str, ...]


# --------------------------------------------------------------------------- builders


def conditions(**overrides: object) -> dict[str, object]:
    return {
        "wind_mph": 9.0,
        "gust_mph": 15.0,
        "rain_in_hr": 0.0,
        "snow_in_hr": 0.0,
        "temperature_f": 38.0,
        "weather_code": 3,
        **overrides,
    }


def window(**overrides: object) -> dict[str, object]:
    return {"start_offset_h": -3.0, "end_offset_h": 4.0, "ramp_h": 1.5, **overrides}


def cell(**overrides: object) -> dict[str, object]:
    return {
        "id": "front",
        "fraction": 0.5,
        "radius_mi": 45.0,
        "core_fraction": 0.5,
        "window": window(),
        "peak": conditions(
            wind_mph=36.0, gust_mph=52.0, snow_in_hr=2.6, temperature_f=22.0, weather_code=75
        ),
        **overrides,
    }


def scenario(**overrides: object) -> dict[str, object]:
    return {
        "id": "storm-on-fastest",
        "name": "Snowstorm on the fastest route",
        "description": "A severe snow cell sits on the middle of the fastest route.",
        "sort_order": 20,
        "baseline": conditions(),
        "cells": [cell()],
        **overrides,
    }


def as_json(document: object) -> str:
    return json.dumps(document)


def validate(document: object) -> Scenario:
    return Scenario.model_validate_json(as_json(document))


def error_locations(document: object) -> list[Location]:
    with pytest.raises(ValidationError) as excinfo:
        validate(document)
    return [error["loc"] for error in excinfo.value.errors()]


def write_scenario(directory: Path, name: str, document: object) -> Path:
    path = directory / name
    path.write_text(as_json(document), encoding="utf-8", newline="\n")
    return path


# --------------------------------------------------------------------------- models


def test_a_complete_document_validates_into_typed_models() -> None:
    parsed = validate(scenario(cells=[cell(motion={"bearing_deg": 90.0, "speed_mph": 12.0})]))

    assert parsed.id == "storm-on-fastest"
    assert parsed.sort_order == 20
    assert parsed.baseline == Conditions(
        wind_mph=9.0,
        gust_mph=15.0,
        rain_in_hr=0.0,
        snow_in_hr=0.0,
        temperature_f=38.0,
        weather_code=3,
    )
    (front,) = parsed.cells
    assert isinstance(front, StormCell)
    assert front.window == ActiveWindow(start_offset_h=-3.0, end_offset_h=4.0, ramp_h=1.5)
    assert front.motion == Motion(bearing_deg=90.0, speed_mph=12.0)
    assert (front.fraction, front.radius_mi, front.core_fraction) == (0.5, 45.0, 0.5)
    assert front.peak.snow_in_hr == 2.6


def test_motion_is_optional_and_means_stationary() -> None:
    (front,) = validate(scenario()).cells
    assert front.motion is None
    assert validate(scenario(cells=[cell(motion=None)])).cells[0].motion is None


def test_a_scenario_without_cells_is_valid() -> None:
    assert validate(scenario(cells=[])).cells == ()


def test_models_are_immutable() -> None:
    parsed = validate(scenario())
    with pytest.raises(ValidationError, match="frozen"):
        parsed.name = "changed"


def test_models_can_be_built_from_python_values_too() -> None:
    front = StormCell(
        id="front",
        fraction=0.5,
        radius_mi=45.0,
        core_fraction=0.5,
        window=ActiveWindow(start_offset_h=-3.0, end_offset_h=4.0, ramp_h=1.5),
        peak=Conditions(
            wind_mph=36.0,
            gust_mph=52.0,
            rain_in_hr=0.0,
            snow_in_hr=2.6,
            temperature_f=22.0,
            weather_code=75,
        ),
    )
    assert front.motion is None
    assert front == validate(scenario()).cells[0]


BAD_KEYS = {
    "top-level-extra": (scenario(unexpected=1), ("unexpected",)),
    "conditions-extra": (scenario(baseline=conditions(humidity=40.0)), ("baseline", "humidity")),
    "cell-extra": (scenario(cells=[cell(spin=1)]), ("cells", 0, "spin")),
    "window-extra": (scenario(cells=[cell(window=window(soon=1))]), ("cells", 0, "window", "soon")),
    "motion-extra": (
        scenario(cells=[cell(motion={"bearing_deg": 1.0, "speed_mph": 1.0, "x": 1})]),
        ("cells", 0, "motion", "x"),
    ),
}


@pytest.mark.parametrize(("document", "location"), list(BAD_KEYS.values()), ids=list(BAD_KEYS))
def test_unknown_keys_are_rejected_everywhere(document: object, location: Location) -> None:
    assert error_locations(document) == [location]


MISSING_KEYS = {
    "id": scenario(id=None),
    "baseline-wind": scenario(baseline={k: v for k, v in conditions().items() if k != "wind_mph"}),
    "cells": {k: v for k, v in scenario().items() if k != "cells"},
    "cell-peak": scenario(cells=[{k: v for k, v in cell().items() if k != "peak"}]),
}


@pytest.mark.parametrize("document", list(MISSING_KEYS.values()), ids=list(MISSING_KEYS))
def test_every_documented_key_is_required_except_motion(document: object) -> None:
    assert error_locations(document)


WRONG_TYPES = {
    "string-number": (scenario(baseline=conditions(wind_mph="9.0")), ("baseline", "wind_mph")),
    "bool-number": (scenario(baseline=conditions(wind_mph=True)), ("baseline", "wind_mph")),
    "float-code": (scenario(baseline=conditions(weather_code=75.0)), ("baseline", "weather_code")),
    "string-code": (scenario(baseline=conditions(weather_code="3")), ("baseline", "weather_code")),
    "bool-code": (scenario(baseline=conditions(weather_code=True)), ("baseline", "weather_code")),
    "float-sort-order": (scenario(sort_order=20.5), ("sort_order",)),
    "string-sort-order": (scenario(sort_order="20"), ("sort_order",)),
    "cells-object": (scenario(cells={"id": "front"}), ("cells",)),
    "cells-string": (scenario(cells="none"), ("cells",)),
    "number-name": (scenario(name=7), ("name",)),
}


@pytest.mark.parametrize(
    ("document", "location"), list(WRONG_TYPES.values()), ids=list(WRONG_TYPES)
)
def test_nothing_is_coerced_values_must_have_exactly_the_documented_type(
    document: object, location: Location
) -> None:
    assert error_locations(document) == [location]


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
@pytest.mark.parametrize(
    "name", ["wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr", "temperature_f"]
)
def test_non_finite_numbers_are_rejected(name: str, bad: float) -> None:
    assert error_locations(scenario(baseline=conditions(**{name: bad}))) == [("baseline", name)]


@pytest.mark.parametrize("bad", [math.nan, math.inf])
@pytest.mark.parametrize("name", ["fraction", "radius_mi", "core_fraction"])
def test_non_finite_cell_geometry_is_rejected(name: str, bad: float) -> None:
    assert error_locations(scenario(cells=[cell(**{name: bad})])) == [("cells", 0, name)]


CONDITION_LIMITS = [
    ("wind_mph", 0.0, 200.0, 0.1),
    ("gust_mph", 0.0, 300.0, 0.1),
    ("rain_in_hr", 0.0, 10.0, 0.1),
    ("snow_in_hr", 0.0, 10.0, 0.1),
    ("temperature_f", -60.0, 130.0, 0.1),
    ("weather_code", 0, 99, 1),
]


@pytest.mark.parametrize(("name", "low", "high", "step"), CONDITION_LIMITS)
def test_condition_values_are_accepted_on_the_limits_and_refused_just_outside(
    name: str, low: float, high: float, step: float
) -> None:
    def peak(value: float) -> dict[str, object]:
        return conditions(**{"wind_mph": 0.0, "gust_mph": 300.0, name: value})

    for inside in (low, high):
        assert isinstance(validate(scenario(cells=[cell(peak=peak(inside))])), Scenario)
    for outside in (low - step, high + step):
        locations = error_locations(scenario(cells=[cell(peak=peak(outside))]))
        assert locations == [("cells", 0, "peak", name)]


def test_gust_may_equal_the_wind_but_never_be_below_it() -> None:
    assert isinstance(
        validate(scenario(baseline=conditions(wind_mph=30.0, gust_mph=30.0))), Scenario
    )
    below = scenario(baseline=conditions(wind_mph=30.0, gust_mph=29.9))
    with pytest.raises(ValidationError, match="gust_mph must be at least wind_mph"):
        validate(below)
    assert error_locations(below) == [("baseline",)]


@pytest.mark.parametrize(
    ("name", "good", "bad"),
    [
        ("fraction", (0.0, 1.0), (-0.01, 1.01)),
        ("radius_mi", (0.001, 400.0), (0.0, -1.0, 400.01)),
        ("core_fraction", (0.0, 0.999), (-0.01, 1.0)),
    ],
)
def test_cell_geometry_limits(name: str, good: tuple[float, ...], bad: tuple[float, ...]) -> None:
    for value in good:
        assert isinstance(validate(scenario(cells=[cell(**{name: value})])), Scenario)
    for value in bad:
        assert error_locations(scenario(cells=[cell(**{name: value})])) == [("cells", 0, name)]


@pytest.mark.parametrize(
    "motion",
    [
        {"bearing_deg": 0.0, "speed_mph": 0.0},
        {"bearing_deg": 360.0, "speed_mph": 120.0},
        {"bearing_deg": 90.5, "speed_mph": 12.5},
    ],
)
def test_motion_accepts_every_bearing_and_speeds_up_to_120_mph(motion: dict[str, float]) -> None:
    assert validate(scenario(cells=[cell(motion=motion)])).cells[0].motion is not None


@pytest.mark.parametrize(
    ("motion", "field"),
    [
        ({"bearing_deg": -0.1, "speed_mph": 10.0}, "bearing_deg"),
        ({"bearing_deg": 360.1, "speed_mph": 10.0}, "bearing_deg"),
        ({"bearing_deg": 90.0, "speed_mph": -0.1}, "speed_mph"),
        ({"bearing_deg": 90.0, "speed_mph": 120.1}, "speed_mph"),
        ({"bearing_deg": math.nan, "speed_mph": 10.0}, "bearing_deg"),
    ],
)
def test_motion_rejects_bearings_and_speeds_out_of_range(
    motion: dict[str, float], field: str
) -> None:
    assert error_locations(scenario(cells=[cell(motion=motion)])) == [("cells", 0, "motion", field)]


# --------------------------------------------------------------------------- active window


@pytest.mark.parametrize(
    "span",
    [
        window(),
        window(ramp_h=0.0),
        window(start_offset_h=0.0, end_offset_h=7.0, ramp_h=3.5),
        window(start_offset_h=-168.0, end_offset_h=168.0, ramp_h=168.0),
        window(start_offset_h=2.0, end_offset_h=2.5, ramp_h=0.25),
    ],
    ids=["typical", "no-ramp", "ramp-is-half", "widest", "narrow"],
)
def test_valid_active_windows(span: dict[str, object]) -> None:
    assert isinstance(validate(scenario(cells=[cell(window=span)])), Scenario)


@pytest.mark.parametrize(
    ("span", "message"),
    [
        (window(start_offset_h=1.0, end_offset_h=1.0, ramp_h=0.0), "end_offset_h must be after"),
        (window(start_offset_h=2.0, end_offset_h=-2.0, ramp_h=0.0), "end_offset_h must be after"),
        (window(ramp_h=3.51), "ramp_h must be at most half of the window"),
        (window(start_offset_h=0.0, end_offset_h=1.0, ramp_h=0.51), "at most half"),
    ],
    ids=["zero-length", "reversed", "ramp-over-half", "short-ramp-over-half"],
)
def test_active_windows_must_run_forwards_with_ramps_that_fit(
    span: dict[str, object], message: str
) -> None:
    document = scenario(cells=[cell(window=span)])
    with pytest.raises(ValidationError, match=message):
        validate(document)
    assert error_locations(document) == [("cells", 0, "window")]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("start_offset_h", -168.1),
        ("start_offset_h", 168.1),
        ("end_offset_h", 168.1),
        ("end_offset_h", -168.1),
        ("ramp_h", -0.1),
        ("ramp_h", 168.1),
        ("ramp_h", math.nan),
        ("start_offset_h", math.inf),
    ],
)
def test_active_window_offsets_stay_within_a_week(name: str, value: float) -> None:
    span = window(**{"start_offset_h": -100.0, "end_offset_h": 100.0, "ramp_h": 1.0, name: value})
    assert error_locations(scenario(cells=[cell(window=span)])) == [("cells", 0, "window", name)]


# --------------------------------------------------------------------------- scenario


@pytest.mark.parametrize("slug", ["a", "calm", "storm-on-fastest", "i-80", "route66", "a" * 48])
def test_slugs_are_lowercase_words_joined_by_single_hyphens(slug: str) -> None:
    assert validate(scenario(id=slug, cells=[cell(id=slug)])).id == slug


@pytest.mark.parametrize(
    "slug", ["", "Storm", "a_b", "-a", "a-", "a--b", "a b", "a.b", "a/b", "é", "a" * 49]
)
def test_bad_slugs_are_rejected_for_scenarios_and_cells(slug: str) -> None:
    assert error_locations(scenario(id=slug)) == [("id",)]
    assert error_locations(scenario(cells=[cell(id=slug)])) == [("cells", 0, "id")]


@pytest.mark.parametrize(
    "text",
    ["", " ", " padded", "padded ", "two\nlines", "tab\t", "x" * 81],
)
def test_names_are_trimmed_single_line_text_of_at_most_80_characters(text: str) -> None:
    assert error_locations(scenario(name=text)) == [("name",)]


def test_a_name_of_exactly_80_characters_is_fine() -> None:
    assert validate(scenario(name="n" * 80)).name == "n" * 80


@pytest.mark.parametrize("text", ["", "  ", " padded", "padded\n", "x" * 601])
def test_descriptions_are_trimmed_text_of_at_most_600_characters(text: str) -> None:
    assert error_locations(scenario(description=text)) == [("description",)]


def test_a_multi_paragraph_description_is_fine() -> None:
    text = "First paragraph.\n\nSecond paragraph."
    assert validate(scenario(description=text)).description == text


@pytest.mark.parametrize("order", [-1, 10_001])
def test_sort_order_is_a_small_non_negative_integer(order: int) -> None:
    assert error_locations(scenario(sort_order=order)) == [("sort_order",)]


def test_sort_order_limits_are_accepted() -> None:
    assert validate(scenario(sort_order=0)).sort_order == 0
    assert validate(scenario(sort_order=10_000)).sort_order == 10_000


def test_at_most_eight_cells_are_allowed() -> None:
    assert MAX_CELLS == 8
    eight = [cell(id=f"cell-{index}") for index in range(8)]
    assert len(validate(scenario(cells=eight)).cells) == 8
    nine = [cell(id=f"cell-{index}") for index in range(9)]
    assert error_locations(scenario(cells=nine)) == [("cells",)]


def test_cell_ids_must_be_unique_within_a_scenario() -> None:
    document = scenario(cells=[cell(id="front"), cell(id="rear"), cell(id="front")])
    with pytest.raises(ValidationError, match="duplicate cell id 'front'"):
        validate(document)
    assert error_locations(document) == [()]


def test_the_same_cell_id_may_appear_in_different_scenarios() -> None:
    assert validate(scenario(id="one")).cells[0].id == validate(scenario(id="two")).cells[0].id


# --------------------------------------------------------------------------- round trip


finite = st.floats(allow_nan=False, allow_infinity=False)


@st.composite
def conditions_models(draw: st.DrawFn) -> Conditions:
    wind = draw(st.floats(0.0, 200.0))
    return Conditions(
        wind_mph=wind,
        gust_mph=draw(st.floats(wind, 300.0)),
        rain_in_hr=draw(st.floats(0.0, 10.0)),
        snow_in_hr=draw(st.floats(0.0, 10.0)),
        temperature_f=draw(st.floats(-60.0, 130.0)),
        weather_code=draw(st.integers(0, 99)),
    )


@st.composite
def storm_cells(draw: st.DrawFn, cell_id: str) -> StormCell:
    start = draw(st.floats(-168.0, 167.0))
    end = draw(st.floats(start + 0.01, 168.0))
    ramp = draw(st.floats(0.0, (end - start) / 2))
    motion = draw(
        st.one_of(
            st.none(),
            st.builds(Motion, bearing_deg=st.floats(0.0, 360.0), speed_mph=st.floats(0.0, 120.0)),
        )
    )
    return StormCell(
        id=cell_id,
        fraction=draw(st.floats(0.0, 1.0)),
        radius_mi=draw(st.floats(0.001, 400.0)),
        core_fraction=draw(st.floats(0.0, 0.999)),
        window=ActiveWindow(start_offset_h=start, end_offset_h=end, ramp_h=ramp),
        peak=draw(conditions_models()),
        motion=motion,
    )


@st.composite
def scenarios(draw: st.DrawFn) -> Scenario:
    count = draw(st.integers(0, MAX_CELLS))
    return Scenario(
        id=draw(st.sampled_from(["calm", "storm-on-fastest", "x1"])),
        name="A scenario",
        description="What it shows.",
        sort_order=draw(st.integers(0, 10_000)),
        baseline=draw(conditions_models()),
        cells=tuple(draw(storm_cells(f"cell-{index}")) for index in range(count)),
    )


@given(parsed=scenarios())
def test_every_valid_scenario_survives_a_json_round_trip_unchanged(parsed: Scenario) -> None:
    assert Scenario.model_validate_json(parsed.model_dump_json()) == parsed


# --------------------------------------------------------------------------- schema


def test_the_schema_declares_draft_2020_12_and_forbids_extra_properties() -> None:
    schema = scenario_json_schema()

    assert (
        schema["$schema"] == JSON_SCHEMA_DIALECT == "https://json-schema.org/draft/2020-12/schema"
    )
    assert schema["title"] == "Scenario"
    assert schema["additionalProperties"] is False
    definitions = schema["$defs"]
    assert isinstance(definitions, dict)
    assert set(definitions) == {"ActiveWindow", "Conditions", "Motion", "StormCell"}
    for definition in definitions.values():
        assert definition["additionalProperties"] is False


def test_the_schema_documents_the_limits_of_the_format() -> None:
    schema = scenario_json_schema()
    properties = schema["properties"]
    assert isinstance(properties, dict)
    assert properties["cells"]["maxItems"] == MAX_CELLS
    assert set(schema["required"]) == {
        "id",
        "name",
        "description",
        "sort_order",
        "baseline",
        "cells",
    }
    assert properties["id"]["pattern"] == "^[a-z0-9]+(-[a-z0-9]+)*$"
    wind = schema["$defs"]["Conditions"]["properties"]["wind_mph"]
    assert (wind["minimum"], wind["maximum"]) == (0, 200)
    assert schema["$defs"]["StormCell"]["properties"]["radius_mi"]["exclusiveMinimum"] == 0


def references(node: object) -> list[str]:
    if isinstance(node, dict):
        found = [value for key, value in node.items() if key == "$ref" and isinstance(value, str)]
        return found + [ref for child in node.values() for ref in references(child)]
    if isinstance(node, list):
        return [ref for child in node for ref in references(child)]
    return []


def test_every_reference_in_the_schema_resolves_inside_the_document() -> None:
    schema = scenario_json_schema()
    refs = references(schema)
    assert refs
    for ref in refs:
        prefix, _, name = ref.rpartition("/")
        assert prefix == "#/$defs"
        assert name in schema["$defs"]


def test_the_schema_file_is_canonical_json_with_sorted_keys_and_a_trailing_newline(
    tmp_path: Path,
) -> None:
    target = tmp_path / "schema.json"

    write_json_schema(target)

    raw = target.read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert text.endswith("}\n")
    assert json.loads(text) == scenario_json_schema()
    assert text == json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def test_the_checked_in_schema_equals_the_generated_one_so_it_cannot_drift(tmp_path: Path) -> None:
    generated = tmp_path / "generated.json"
    write_json_schema(generated)

    checked_in = (SHIPPED_DIR / SCHEMA_FILE_NAME).read_text(encoding="utf-8")

    assert checked_in == generated.read_text(encoding="utf-8"), (
        "shared/scenarios/scenario.schema.json is stale: regenerate it with "
        "haulcast.providers.weather.scenarios.write_json_schema(<that path>)"
    )


# --------------------------------------------------------------------------- shipped files


def test_the_four_demo_scenarios_ship_in_the_documented_order() -> None:
    catalog = ScenarioCatalog.load()

    assert [item.id for item in catalog.all()] == SHIPPED_IDS
    assert [item.sort_order for item in catalog.all()] == [10, 20, 30, 40]
    assert {path.stem for path in SHIPPED_FILES} == set(SHIPPED_IDS)


@pytest.mark.parametrize("path", SHIPPED_FILES, ids=[path.name for path in SHIPPED_FILES])
def test_every_shipped_scenario_file_validates_and_is_named_after_its_id(path: Path) -> None:
    raw = path.read_bytes()

    parsed = Scenario.model_validate_json(raw)

    assert parsed.id == path.stem
    assert raw.endswith(b"\n")
    assert b"\r" not in raw


def test_calm_is_the_only_scenario_without_storm_cells() -> None:
    empty = [item.id for item in ScenarioCatalog.load().all() if not item.cells]
    assert empty == ["calm"]


def test_shipped_descriptions_are_plain_text_a_reader_can_trust() -> None:
    for item in ScenarioCatalog.load().all():
        assert item.description.isascii()
        assert item.description.endswith(".")
        assert len(item.description) >= 60
        assert item.name.isascii()


# --------------------------------------------------------------------------- catalog


def test_the_catalog_orders_scenarios_by_sort_order_then_id(tmp_path: Path) -> None:
    write_scenario(tmp_path, "b.json", scenario(id="b", sort_order=20, cells=[]))
    write_scenario(tmp_path, "a.json", scenario(id="a", sort_order=20, cells=[]))
    write_scenario(tmp_path, "c.json", scenario(id="c", sort_order=5, cells=[]))

    catalog = ScenarioCatalog.load(tmp_path)

    assert [item.id for item in catalog.all()] == ["c", "a", "b"]


def test_the_catalog_ignores_the_schema_file_and_other_files(tmp_path: Path) -> None:
    write_scenario(tmp_path, "one.json", scenario(id="one"))
    (tmp_path / SCHEMA_FILE_NAME).write_text("not even json", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("{}", encoding="utf-8")
    (tmp_path / "two.json.bak").write_text("{}", encoding="utf-8")

    assert [item.id for item in ScenarioCatalog.load(tmp_path).all()] == ["one"]


def test_get_returns_a_scenario_by_id(tmp_path: Path) -> None:
    write_scenario(tmp_path, "one.json", scenario(id="one"))
    catalog = ScenarioCatalog.load(tmp_path)

    assert catalog.get("one") == validate(scenario(id="one"))


def test_an_unknown_id_raises_a_key_error_that_names_it(tmp_path: Path) -> None:
    catalog = ScenarioCatalog.load(tmp_path)

    with pytest.raises(UnknownScenarioError) as excinfo:
        catalog.get("sunny")

    assert isinstance(excinfo.value, KeyError)
    assert excinfo.value.scenario_id == "sunny"
    assert str(excinfo.value) == "unknown scenario 'sunny'"


def test_an_unknown_id_in_an_error_message_is_kept_short_and_escaped() -> None:
    message = str(UnknownScenarioError("x" * 500 + "\nrm -rf"))
    assert len(message) < 120
    assert "\n" not in message


def test_summaries_list_what_a_picker_needs_in_catalog_order(tmp_path: Path) -> None:
    write_scenario(
        tmp_path, "z.json", scenario(id="z", name="Zed", description="Last.", sort_order=9)
    )
    write_scenario(
        tmp_path, "a.json", scenario(id="a", name="Aye", description="First.", sort_order=1)
    )

    assert ScenarioCatalog.load(tmp_path).summaries() == (
        ScenarioSummary(id="a", name="Aye", description="First."),
        ScenarioSummary(id="z", name="Zed", description="Last."),
    )


def test_all_returns_an_immutable_tuple(tmp_path: Path) -> None:
    write_scenario(tmp_path, "one.json", scenario(id="one"))
    assert isinstance(ScenarioCatalog.load(tmp_path).all(), tuple)


def test_an_empty_directory_gives_an_empty_catalog(tmp_path: Path) -> None:
    catalog = ScenarioCatalog.load(tmp_path)
    assert catalog.all() == ()
    assert catalog.summaries() == ()


def test_a_missing_directory_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ScenarioFileError, match="not a directory"):
        ScenarioCatalog.load(tmp_path / "nope")


def test_duplicate_ids_across_files_are_refused_naming_both_files(tmp_path: Path) -> None:
    write_scenario(tmp_path, "first.json", scenario(id="same"))
    write_scenario(tmp_path, "second.json", scenario(id="same"))

    with pytest.raises(ScenarioFileError, match="duplicate scenario id 'same'") as excinfo:
        ScenarioCatalog.load(tmp_path)

    assert excinfo.value.file_name == "second.json"
    assert "first.json" in str(excinfo.value)


def test_building_a_catalog_from_scenarios_rejects_duplicate_ids() -> None:
    with pytest.raises(ValueError, match="unique"):
        ScenarioCatalog([validate(scenario(id="same")), validate(scenario(id="same"))])


def test_the_default_directory_is_the_shared_scenarios_folder_and_can_be_redirected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert [item.id for item in ScenarioCatalog.load().all()] == SHIPPED_IDS

    (tmp_path / "scenarios").mkdir()
    write_scenario(tmp_path / "scenarios", "elsewhere.json", scenario(id="elsewhere"))
    monkeypatch.setenv(SHARED_DIR_VARIABLE, str(tmp_path))

    assert [item.id for item in ScenarioCatalog.load().all()] == ["elsewhere"]


LEAK_MARKER = "TOPSECRET-MARKER"
BROKEN_FILES = {
    "truncated-json": f'{{"id": "{LEAK_MARKER}'.encode(),
    "not-json": f"this is not json {LEAK_MARKER}".encode(),
    "array-root": f'["{LEAK_MARKER}"]'.encode(),
    "empty": b"",
    "invalid-utf8": b'{"id": "\xff\xfe' + LEAK_MARKER.encode(),
    "bad-slug": as_json(scenario(id=f"{LEAK_MARKER}_BAD")).encode(),
    "extra-key": as_json(scenario(**{LEAK_MARKER: 1})).encode(),
    "wrong-type": as_json(scenario(sort_order=LEAK_MARKER)).encode(),
    "bad-cell": as_json(scenario(cells=[cell(radius_mi=-LEAK_MARKER.__len__())])).encode(),
}


@pytest.mark.parametrize("content", list(BROKEN_FILES.values()), ids=list(BROKEN_FILES))
def test_a_malformed_file_is_refused_by_name_without_echoing_its_content(
    tmp_path: Path, content: bytes
) -> None:
    (tmp_path / "broken.json").write_bytes(content)

    with pytest.raises(ScenarioFileError) as excinfo:
        ScenarioCatalog.load(tmp_path)

    assert excinfo.value.file_name == "broken.json"
    assert str(excinfo.value).startswith("broken.json: ")
    assert LEAK_MARKER not in str(excinfo.value)
    assert str(tmp_path) not in str(excinfo.value)
    assert excinfo.value.__cause__ is None


def test_the_message_says_where_in_the_document_the_problem_is(tmp_path: Path) -> None:
    write_scenario(tmp_path, "bad.json", scenario(cells=[cell(window=window(ramp_h=9.0))]))

    with pytest.raises(ScenarioFileError) as excinfo:
        ScenarioCatalog.load(tmp_path)

    assert "cells.0.window" in str(excinfo.value)
    assert "ramp_h must be at most half of the window" in str(excinfo.value)


def test_at_most_five_problems_are_listed_and_the_rest_are_counted(tmp_path: Path) -> None:
    bad = conditions(wind_mph=-1.0, rain_in_hr=-1.0, snow_in_hr=-1.0, temperature_f=-99.0)
    write_scenario(tmp_path, "bad.json", scenario(id="X", name="", baseline=bad, sort_order=-1))

    with pytest.raises(ScenarioFileError) as excinfo:
        ScenarioCatalog.load(tmp_path)

    message = str(excinfo.value)
    assert message.count("; ") == 5
    assert message.endswith("(and 2 more)")


def test_a_json_error_does_not_pretend_to_have_a_location(tmp_path: Path) -> None:
    (tmp_path / "broken.json").write_bytes(b"{")

    with pytest.raises(ScenarioFileError, match=r"^broken\.json: <file>: Invalid JSON"):
        ScenarioCatalog.load(tmp_path)


def test_an_entry_that_cannot_be_read_is_refused_by_name(tmp_path: Path) -> None:
    (tmp_path / "folder.json").mkdir()

    with pytest.raises(ScenarioFileError, match=r"^folder\.json: cannot be read") as excinfo:
        ScenarioCatalog.load(tmp_path)

    assert isinstance(excinfo.value.__cause__, OSError)
