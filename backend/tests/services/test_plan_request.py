"""The normalized plan request, its idempotency hash, and plan ids (API-CONTRACT idempotency)."""

import math
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone

import pytest

from haulcast.services.plan_ids import PLAN_ID_PATTERN, new_plan_id
from haulcast.services.plan_request import Place, PlanRequest, clean_label

DEPARTURE = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)
CROCKFORD_DECODE = {char: value for value, char in enumerate("0123456789ABCDEFGHJKMNPQRSTVWXYZ")}


def request(**changes: object) -> PlanRequest:
    """A valid normalized request (Salt Lake City to Denver) with ``changes`` applied."""
    base = PlanRequest(
        origin=Place(40.7608, -111.8910, "Salt Lake City, Utah, United States"),
        destination=Place(39.7392, -104.9903, "Denver, Colorado, United States"),
        departure=DEPARTURE,
        load_weight_lb=38_000,
        sampling_interval_mi=25,
        scenario=None,
    ).normalized()
    return replace(base, **changes)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- normalization


def test_coordinates_are_rounded_to_four_decimals() -> None:
    normalized = PlanRequest(
        origin=Place(40.760849, -111.891049, "A"),
        destination=Place(39.739251, -104.990351, "B"),
        departure=DEPARTURE,
        load_weight_lb=0,
        sampling_interval_mi=10,
        scenario=None,
    ).normalized()

    assert (normalized.origin.lat, normalized.origin.lon) == (40.7608, -111.891)
    assert (normalized.destination.lat, normalized.destination.lon) == (39.7393, -104.9904)


def test_a_coordinate_that_rounds_to_zero_is_positive_zero() -> None:
    normalized = PlanRequest(
        origin=Place(-0.00001, -0.00002, "A"),
        destination=Place(10.0, 10.0, "B"),
        departure=DEPARTURE,
        load_weight_lb=0,
        sampling_interval_mi=10,
        scenario=None,
    ).normalized()

    assert math.copysign(1.0, normalized.origin.lat) == 1.0
    assert math.copysign(1.0, normalized.origin.lon) == 1.0


def test_the_departure_is_floored_to_the_minute_and_expressed_in_utc() -> None:
    local = datetime(2026, 10, 20, 8, 0, 59, 999_999, tzinfo=timezone(timedelta(hours=-6)))

    normalized = PlanRequest(
        origin=Place(40.0, -111.0, "A"),
        destination=Place(39.0, -105.0, "B"),
        departure=local,
        load_weight_lb=1,
        sampling_interval_mi=25,
        scenario="calm",
    ).normalized()

    assert normalized.departure == DEPARTURE
    assert normalized.departure.utcoffset() == timedelta(0)


def test_a_naive_departure_is_refused() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        PlanRequest(
            origin=Place(40.0, -111.0, "A"),
            destination=Place(39.0, -105.0, "B"),
            departure=datetime(2026, 10, 20, 14, 0),  # noqa: DTZ001 - the point of the test
            load_weight_lb=1,
            sampling_interval_mi=25,
            scenario=None,
        ).normalized()


def test_the_echo_is_the_documented_normalized_request() -> None:
    assert request(scenario="calm").to_json() == {
        "origin": {
            "lat": 40.7608,
            "lon": -111.891,
            "label": "Salt Lake City, Utah, United States",
        },
        "destination": {
            "lat": 39.7392,
            "lon": -104.9903,
            "label": "Denver, Colorado, United States",
        },
        "departure_time": "2026-10-20T14:00:00Z",
        "load_weight_lb": 38_000,
        "sampling_interval_mi": 25,
        "scenario": "calm",
    }


# --------------------------------------------------------------------------- the idempotency hash


def test_the_hash_is_a_sha256_hex_digest() -> None:
    assert re.fullmatch(r"[0-9a-f]{64}", request().request_hash)


def test_requests_equal_after_normalization_share_a_hash() -> None:
    noisy = PlanRequest(
        origin=Place(40.760800004, -111.891000004, "Somewhere else entirely"),
        destination=Place(39.739200004, -104.990300004, "Another label"),
        departure=datetime(2026, 10, 20, 8, 0, 30, tzinfo=timezone(timedelta(hours=-6))),
        load_weight_lb=38_000,
        sampling_interval_mi=25,
        scenario=None,
    ).normalized()

    assert noisy.request_hash == request().request_hash


def test_labels_do_not_change_the_hash() -> None:
    relabelled = request(origin=Place(40.7608, -111.891, "SLC"))

    assert relabelled.request_hash == request().request_hash


@pytest.mark.parametrize(
    "changes",
    [
        {"origin": Place(40.7609, -111.891, "x")},
        {"origin": Place(40.7608, -111.8911, "x")},
        {"destination": Place(39.7393, -104.9903, "x")},
        {"destination": Place(39.7392, -104.9904, "x")},
        {"departure": DEPARTURE + timedelta(minutes=1)},
        {"load_weight_lb": 38_001},
        {"sampling_interval_mi": 50},
        {"scenario": "calm"},
    ],
    ids=[
        "origin-lat",
        "origin-lon",
        "destination-lat",
        "destination-lon",
        "departure-minute",
        "load",
        "interval",
        "scenario",
    ],
)
def test_every_input_that_matters_changes_the_hash(changes: dict[str, object]) -> None:
    assert request(**changes).request_hash != request().request_hash


def test_swapping_origin_and_destination_changes_the_hash() -> None:
    base = request()

    swapped = request(origin=base.destination, destination=base.origin)

    assert swapped.request_hash != base.request_hash


# --------------------------------------------------------------------------- labels


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("Salt Lake City", "Salt Lake City"),
        ("  Salt\u200b Lake\x00 City\n ", "Salt Lake City"),
        ("\u202eevil\u202c label", "evil label"),
        ("Zürich", "Zürich"),
        ("\x00\x1f\u200b", ""),
        ("   ", ""),
    ],
)
def test_control_and_format_characters_are_stripped_from_labels(raw: str, cleaned: str) -> None:
    assert clean_label(raw) == cleaned


# --------------------------------------------------------------------------- plan ids


def decode_time(plan_id: str) -> int:
    """Decode the 10 character Crockford timestamp of a ``pln_`` ULID back to milliseconds."""
    value = 0
    for char in plan_id.removeprefix("pln_")[:10]:
        value = value * 32 + CROCKFORD_DECODE[char]
    return value


def test_a_plan_id_is_pln_plus_a_26_character_ulid() -> None:
    plan_id = new_plan_id(DEPARTURE)

    assert plan_id.startswith("pln_")
    assert len(plan_id) == 30
    assert PLAN_ID_PATTERN.fullmatch(plan_id)


def test_the_timestamp_part_matches_the_ulid_specification() -> None:
    moment = datetime.fromtimestamp(1_469_918_176.385, UTC)

    plan_id = new_plan_id(moment, entropy=bytes)

    assert plan_id == "pln_01ARYZ6S41" + "0" * 16
    assert decode_time(plan_id) == 1_469_918_176_385


def test_maximal_entropy_fills_the_random_part() -> None:
    plan_id = new_plan_id(DEPARTURE, entropy=lambda size: b"\xff" * size)

    assert plan_id.endswith("Z" * 16)


def test_ids_made_later_sort_later() -> None:
    first = new_plan_id(DEPARTURE, entropy=lambda size: b"\xff" * size)
    second = new_plan_id(DEPARTURE + timedelta(milliseconds=1), entropy=bytes)

    assert first < second


def test_two_ids_from_the_same_instant_differ() -> None:
    assert new_plan_id(DEPARTURE) != new_plan_id(DEPARTURE)


def test_a_time_before_the_epoch_is_refused() -> None:
    with pytest.raises(ValueError, match="48 bits"):
        new_plan_id(datetime(1969, 12, 31, tzinfo=UTC))


VALID_ID = "pln_01ARYZ6S41" + "0" * 16


@pytest.mark.parametrize(
    "candidate",
    [
        "",
        "pln_",
        VALID_ID.lower(),
        VALID_ID[:-1],
        VALID_ID + "0",
        VALID_ID[:-2] + "UI",
        "plan_" + VALID_ID[4:],
        "pln_8" + VALID_ID[5:],
        "../hosts",
    ],
)
def test_the_pattern_rejects_anything_that_is_not_a_plan_id(candidate: str) -> None:
    assert PLAN_ID_PATTERN.fullmatch(candidate) is None
