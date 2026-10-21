"""One source of truth for the numbers and helpers that used to be copied between adapters (R2-38).

Four modules each declared the coordinate bounds and two geocoding parsers each carried the same
``_bounded``; the default truck speed was written three times and the ``X-Client-Id`` header twice.
A copy drifts: change one and the others quietly keep the old value. These tests pin that each of
them now has exactly one definition, and that the shared helpers behave as the copies did.
"""

import inspect
import math
from pathlib import Path

import pytest

from haulcast.config import env
from haulcast.geo import MAX_LAT, MAX_LON, bounded_coordinate
from haulcast.providers.routing import osrm, valhalla

SRC = Path(__file__).resolve().parents[1] / "src" / "haulcast"
COORDINATE_BOUNDS = ("_MAX_LAT", "_MAX_LON")


def test_the_coordinate_bounds_are_the_ones_of_the_globe() -> None:
    assert (MAX_LAT, MAX_LON) == (90.0, 180.0)


@pytest.mark.parametrize(
    ("value", "bound", "expected"),
    [
        pytest.param(39.7, 90.0, 39.7, id="inside"),
        pytest.param(-90, 90.0, -90.0, id="the bound itself, an int"),
        pytest.param(180.0, 180.0, 180.0, id="the longitude bound"),
        pytest.param(90.0001, 90.0, None, id="just outside"),
        pytest.param(math.nan, 90.0, None, id="not a number"),
        pytest.param(math.inf, 90.0, None, id="infinite"),
        pytest.param(True, 90.0, None, id="a bool is not a coordinate"),
        pytest.param("39.7", 90.0, None, id="text"),
        pytest.param(None, 90.0, None, id="nothing"),
    ],
)
def test_a_coordinate_is_a_finite_number_inside_its_bound_or_nothing(
    value: object, bound: float, expected: float | None
) -> None:
    assert bounded_coordinate(value, bound) == expected


def test_no_module_declares_its_own_coordinate_bounds_or_bounded_helper() -> None:
    offenders = [
        f"{path.relative_to(SRC)}: {needle}"
        for path in sorted(SRC.rglob("*.py"))
        if path.name != "geo.py"
        for needle in (
            *(f"{name}: Final" for name in COORDINATE_BOUNDS),
            "def _bounded(value: object, bound: float)",
        )
        if needle in path.read_text(encoding="utf-8")
    ]

    assert offenders == []


def test_both_routing_adapters_default_to_the_one_truck_speed_the_settings_do() -> None:
    assert env.DEFAULT_TRUCK_TOP_SPEED_KPH == 105.0
    for adapter in (osrm.OsrmProvider, valhalla.ValhallaProvider):
        parameter = inspect.signature(adapter).parameters["top_speed_kph"]
        assert parameter.default == env.DEFAULT_TRUCK_TOP_SPEED_KPH


def test_the_client_id_header_is_built_in_one_place() -> None:
    assert valhalla.client_headers() == {"X-Client-Id": valhalla.CLIENT_ID}
    sources = [
        path.relative_to(SRC).as_posix()
        for path in sorted(SRC.rglob("*.py"))
        if '"X-Client-Id"' in path.read_text(encoding="utf-8")
    ]
    assert sources == ["providers/routing/valhalla.py"]
