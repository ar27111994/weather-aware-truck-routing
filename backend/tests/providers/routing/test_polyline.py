"""Unit tests for the Google polyline decoder shared by the Valhalla and OSRM adapters."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.routing.polyline import decode_polyline
from tests.providers.routing.support import dig, encode_polyline, fixture_json

# The worked example from Google's "Encoded Polyline Algorithm Format" documentation.
GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
GOOGLE_EXAMPLE_POINTS = ((38.5, -120.2), (40.7, -120.95), (43.252, -126.453))


def test_decodes_the_documented_google_example() -> None:
    assert decode_polyline(GOOGLE_EXAMPLE, 5) == GOOGLE_EXAMPLE_POINTS


def test_precision_only_changes_the_scale_of_the_same_integers() -> None:
    at_6 = decode_polyline(GOOGLE_EXAMPLE, 6)

    assert at_6 == tuple(pytest.approx((lat / 10, lon / 10)) for lat, lon in GOOGLE_EXAMPLE_POINTS)


def test_decodes_the_empty_string_to_no_points() -> None:
    assert decode_polyline("", 6) == ()


def test_decodes_a_recorded_valhalla_shape() -> None:
    document = fixture_json("valhalla-slc-den-truck-alt2.json")
    shape = dig(document, "trip", "legs", 0, "shape")
    assert isinstance(shape, str)

    points = decode_polyline(shape, 6)

    # PROVIDERS.md Q1: this shape decodes to 5,056 points between Salt Lake City and Denver.
    assert len(points) == 5056
    assert points[0] == pytest.approx((40.7608, -111.891), abs=0.01)
    assert points[-1] == pytest.approx((39.7392, -104.9903), abs=0.01)


def test_decodes_a_recorded_osrm_geometry() -> None:
    document = fixture_json("osrm-slc-den-alt3.json")
    geometry = dig(document, "routes", 0, "geometry")
    assert isinstance(geometry, str)

    points = decode_polyline(geometry, 6)

    # PROVIDERS.md Q2: 5,559 annotation entries, hence 5,560 coordinates.
    assert len(points) == 5560
    assert points[0] == pytest.approx((40.7608, -111.891), abs=0.01)
    assert points[-1] == pytest.approx((39.7392, -104.9903), abs=0.01)


@given(
    points=st.lists(
        st.tuples(
            st.integers(min_value=-9_000_000, max_value=9_000_000),
            st.integers(min_value=-18_000_000, max_value=18_000_000),
        ),
        max_size=40,
    ),
    precision=st.sampled_from([5, 6]),
)
def test_round_trips_whatever_the_reference_encoder_produces(
    points: list[tuple[int, int]], precision: int
) -> None:
    expected = tuple((lat / 10**precision, lon / 10**precision) for lat, lon in points)

    assert decode_polyline(encode_polyline(expected, precision), precision) == expected


@pytest.mark.parametrize(
    ("encoded", "message"),
    [
        (GOOGLE_EXAMPLE[:-1], "ends in the middle of a value"),
        ("_", "ends in the middle of a value"),
        ("?", "without its longitude"),
        (GOOGLE_EXAMPLE[:10] + "?", "without its longitude"),
        ("_p~iF ~ps|U", "invalid polyline character ' '"),
        ("_p~iF\x7f~ps|U", "invalid polyline character"),
        ("_p~iFé~ps|U", "invalid polyline character"),
        ("_" * 7 + "?", "value is too long"),
    ],
)
def test_rejects_truncated_or_corrupt_input(encoded: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        decode_polyline(encoded, 6)


def test_rejects_a_negative_precision() -> None:
    with pytest.raises(ValueError, match="precision must not be negative"):
        decode_polyline(GOOGLE_EXAMPLE, -1)
