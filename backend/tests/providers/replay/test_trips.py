"""Tests of the trip table, the gazetteer built from its endpoints and the frozen clock."""

from datetime import UTC, datetime

import pytest

from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.clock import frozen_clock
from haulcast.providers.replay.trips import TRIPS, Trip, gazetteer


def test_the_table_holds_the_four_recorded_trips() -> None:
    assert [trip.name for trip in TRIPS] == ["slc-den", "chi-den", "newark-jc", "la-phx"]


@pytest.mark.parametrize("trip", TRIPS, ids=lambda trip: trip.name)
def test_every_trip_has_both_of_its_recorded_routes(catalog: ReplayCatalog, trip: Trip) -> None:
    assert catalog.read_bytes("routing", trip.valhalla)
    assert catalog.read_bytes("routing", trip.osrm)


@pytest.mark.parametrize("trip", TRIPS, ids=lambda trip: trip.name)
def test_the_recorded_valhalla_request_names_the_endpoints_of_its_trip(
    catalog: ReplayCatalog, trip: Trip
) -> None:
    index = catalog.recorded("routing", "INDEX.json")

    first, second = index[trip.valhalla]["request"]["json"]["locations"]

    assert (first["lat"], first["lon"]) == trip.origin
    assert (second["lat"], second["lon"]) == trip.destination


def test_the_gazetteer_holds_the_seven_cities_of_the_trips() -> None:
    assert [place.name for place in gazetteer()] == [
        "Salt Lake City",
        "Denver",
        "Chicago",
        "Newark",
        "Jersey City",
        "Los Angeles",
        "Phoenix",
    ]


def test_a_gazetteer_place_has_the_label_and_position_of_its_trip_endpoint() -> None:
    positions = {place.label: (place.lat, place.lon) for place in gazetteer()}

    assert len(positions) == 7
    for trip in TRIPS:
        assert positions[trip.origin_label] == trip.origin
        assert positions[trip.destination_label] == trip.destination


def test_every_gazetteer_place_is_in_the_united_states() -> None:
    assert {place.country for place in gazetteer()} == {"United States"}


def test_a_trip_label_must_be_name_state_country() -> None:
    odd = Trip(
        "odd", (1.0, 2.0), (3.0, 4.0), "Nowhere", "Here, There, Anywhere", "v.json", "o.json"
    )

    with pytest.raises(ValueError, match="name, state, country"):
        gazetteer((odd,))


def test_a_frozen_clock_always_tells_the_same_instant() -> None:
    instant = datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
    clock = frozen_clock(instant)

    assert clock() == instant
    assert clock() is clock()


def test_a_frozen_clock_needs_a_zone() -> None:
    naive = datetime.fromisoformat("2026-10-20T13:40:00")

    with pytest.raises(ValueError, match="timezone"):
        frozen_clock(naive)
