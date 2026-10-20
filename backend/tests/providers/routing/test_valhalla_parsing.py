"""Valhalla adapter: error mapping, refusal of inconsistent data, labels and the time spreading."""

import copy
import json
import math
from collections.abc import Callable, Sequence

import httpx
import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.routing.base import NoRouteFoundError
from haulcast.providers.routing.diversity import DiversityPolicy
from haulcast.providers.routing.valhalla import NEUTRAL_LABEL, normalise_road_name
from tests.providers.routing.support import as_dict, dig, encode_polyline, fixture_json
from tests.providers.routing.test_valhalla import (
    ATL,
    DAL,
    DEN,
    SLC,
    ValhallaDouble,
    provider_for,
    spoil_first_polygon_call,
)

MISSING = object()
SMALL = "valhalla-newark-jc-truck-alt2.json"
NO_FORCING = DiversityPolicy(max_extra_calls=0)


def respond_with(document: object, status: int = 200) -> Callable[[httpx.Request], httpx.Response]:
    """Answer every request with ``document``; ``NaN`` / ``Infinity`` pass, as in Python JSON."""
    body = json.dumps(document).encode()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers={"content-type": "application/json"})

    return handler


def with_value(document: object, path: tuple[str | int, ...], value: object) -> object:
    """Return a deep copy of ``document`` with ``path`` replaced (deleted for ``MISSING``)."""
    clone = copy.deepcopy(document)
    parent = dig(clone, *path[:-1])
    key = path[-1]
    if isinstance(parent, dict) and isinstance(key, str):
        if value is MISSING:
            del parent[key]
        else:
            parent[key] = value
    elif isinstance(parent, list) and isinstance(key, int):
        parent[key] = value
    else:
        raise TypeError("path does not lead into a container")
    return clone


def route_small(document: object) -> None:
    provider_for(respond_with(document), policy=NO_FORCING).route(
        (-74.1724, 40.7357), (-74.0431, 40.7178), load_weight_lb=20_000
    )


# ---------------------------------------------------------------------------- error mapping


def test_a_trip_that_is_too_long_for_the_server_is_a_rejection_that_keeps_its_code() -> None:
    handler = respond_with(fixture_json("valhalla-error-too-far.json"), status=400)

    with pytest.raises(ProviderRejectedError) as excinfo:
        provider_for(handler).route(SLC, DEN, load_weight_lb=38_000)

    assert (excinfo.value.status, excinfo.value.code) == (400, "154")


@pytest.mark.parametrize("code", [170, 171, 442])
def test_the_servers_no_route_answers_become_a_no_route_error(code: int) -> None:
    body = {"error_code": code, "error": "No path could be found", "status_code": 400}

    with pytest.raises(NoRouteFoundError) as excinfo:
        provider_for(respond_with(body, status=400)).route(SLC, DEN, load_weight_lb=38_000)

    assert excinfo.value.provider == "valhalla"
    assert isinstance(excinfo.value.__cause__, ProviderRejectedError)


def test_the_recorded_no_path_answer_is_a_no_route_error() -> None:
    handler = respond_with(fixture_json("valhalla-error-no-path.json"), status=400)

    with pytest.raises(NoRouteFoundError):
        provider_for(handler).route(SLC, DEN, load_weight_lb=38_000)


def test_any_other_rejection_is_passed_on_unchanged() -> None:
    body = {"error_code": 167, "error": "Exceeded maximum circumference", "status_code": 400}

    with pytest.raises(ProviderRejectedError) as excinfo:
        provider_for(respond_with(body, status=400)).route(SLC, DEN, load_weight_lb=38_000)

    assert excinfo.value.code == "167"


def test_server_errors_and_rate_limits_are_typed() -> None:
    with pytest.raises(ProviderRateLimitedError):
        provider_for(lambda _request: httpx.Response(429)).route(SLC, DEN, load_weight_lb=38_000)
    with pytest.raises(ProviderUnavailableError) as excinfo:
        provider_for(lambda _request: httpx.Response(503)).route(SLC, DEN, load_weight_lb=38_000)
    assert not isinstance(excinfo.value, ProviderRateLimitedError)


def test_a_timeout_is_an_unavailable_provider() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderUnavailableError):
        provider_for(handler).route(SLC, DEN, load_weight_lb=38_000)


def test_an_answer_that_is_not_json_is_a_response_error() -> None:
    def html(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>502 bad gateway</html>")

    with pytest.raises(ProviderResponseError):
        provider_for(html).route(SLC, DEN, load_weight_lb=38_000)


# --------------------------------------------------------------- inconsistent documents


def maneuver_path(index: int, key: str) -> tuple[str | int, ...]:
    return ("trip", "legs", 0, "maneuvers", index, key)


def first_maneuver_end() -> int:
    end = dig(fixture_json(SMALL), "trip", "legs", 0, "maneuvers", 0, "end_shape_index")
    assert isinstance(end, int)
    return end


BAD_DOCUMENTS = {
    "root-is-a-list": ((), []),
    "trip-missing": (("trip",), MISSING),
    "trip-is-null": (("trip",), None),
    "summary-missing": (("trip", "summary"), MISSING),
    "length-is-text": (("trip", "summary", "length"), "8.9"),
    "length-is-bool": (("trip", "summary", "length"), True),
    "length-negative": (("trip", "summary", "length"), -1.0),
    "length-nan": (("trip", "summary", "length"), math.nan),
    "length-infinite": (("trip", "summary", "length"), math.inf),
    "length-zero": (("trip", "summary", "length"), 0.0),
    "time-zero": (("trip", "summary", "time"), 0.0),
    "time-doubled": (("trip", "summary", "time"), 99_999.0),
    "legs-empty": (("trip", "legs"), []),
    "legs-not-a-list": (("trip", "legs"), "none"),
    "shape-missing": (("trip", "legs", 0, "shape"), MISSING),
    "shape-not-text": (("trip", "legs", 0, "shape"), 12),
    "shape-bad-alphabet": (("trip", "legs", 0, "shape"), "!!!!!!"),
    "shape-cut-after-latitude": (("trip", "legs", 0, "shape"), "A"),
    "shape-single-point": (("trip", "legs", 0, "shape"), encode_polyline([(40.7, -74.0)], 6)),
    "shape-off-the-globe": (
        ("trip", "legs", 0, "shape"),
        encode_polyline([(95.0, -74.0), (96.0, -74.0)], 6),
    ),
    "maneuvers-missing": (("trip", "legs", 0, "maneuvers"), MISSING),
    "maneuvers-empty": (("trip", "legs", 0, "maneuvers"), []),
    "maneuver-not-an-object": (("trip", "legs", 0, "maneuvers", 0), "turn"),
    "maneuver-begin-has-a-gap": (maneuver_path(1, "begin_shape_index"), first_maneuver_end() + 1),
    "maneuver-begin-off-the-shape": (maneuver_path(1, "begin_shape_index"), 10**6),
    "maneuver-begin-is-text": (maneuver_path(1, "begin_shape_index"), "3"),
    "maneuver-begin-is-bool": (maneuver_path(0, "begin_shape_index"), False),
    "maneuver-end-before-begin": (maneuver_path(1, "end_shape_index"), 0),
    "maneuver-end-off-the-shape": (maneuver_path(0, "end_shape_index"), 10**9),
    "maneuver-time-negative": (maneuver_path(0, "time"), -5.0),
    "maneuver-time-missing": (maneuver_path(0, "time"), MISSING),
    "maneuver-length-missing": (maneuver_path(0, "length"), MISSING),
    "alternates-not-a-list": (("alternates",), "none"),
    "alternate-not-an-object": (("alternates", 0), 7),
    "alternate-without-trip": (("alternates", 0, "trip"), MISSING),
}


@pytest.mark.parametrize(("path", "value"), list(BAD_DOCUMENTS.values()), ids=list(BAD_DOCUMENTS))
def test_inconsistent_documents_are_refused_not_repaired(
    path: tuple[str | int, ...], value: object
) -> None:
    document = value if not path else with_value(fixture_json(SMALL), path, value)

    with pytest.raises(ProviderResponseError):
        route_small(document)


def test_maneuvers_that_stop_short_of_the_shape_are_refused() -> None:
    document = fixture_json(SMALL)
    maneuvers = dig(document, "trip", "legs", 0, "maneuvers")
    assert isinstance(maneuvers, list)
    assert len(maneuvers) > 3

    shortened = with_value(document, ("trip", "legs", 0, "maneuvers"), maneuvers[:-2])

    with pytest.raises(ProviderResponseError, match="do not cover"):
        route_small(shortened)


def test_a_malformed_forced_route_is_skipped_like_any_other_unusable_answer() -> None:
    inner = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    handler = spoil_first_polygon_call(
        inner, lambda: httpx.Response(200, json={"trip": {"summary": {}}})
    )

    result = provider_for(handler).route(DAL, ATL, load_weight_lb=38_000)

    assert len(result.routes) == 3


# ------------------------------------------------------------------------------- labels


@pytest.mark.parametrize(
    ("raw", "label"),
    [
        ("I 80", "I-80"),
        ("I 25 South", "I-25"),
        ("I 70 East", "I-70"),
        ("US 40", "US-40"),
        ("CA 60 East", "CA-60"),
        ("SR 269", "SR-269"),
        ("NJ 139", "NJ-139"),
        ("US 287 North", "US-287"),
        ("East Highway 6", "Highway 6"),
        ("North Avenue", "North Avenue"),
        ("Main Street", "Main Street"),
        ("East", "East"),
        ("South 4th Street", "4th Street"),
        ("  I \t 80\u0000 ", "I-80"),
        ("", ""),
        ("A 1B", "A-1B"),
        ("I 80 Business Loop", "I 80 Business Loop"),
        ("x" * 100, "x" * 40),
    ],
)
def test_road_names_are_normalised_to_short_labels(raw: str, label: str) -> None:
    assert normalise_road_name(raw) == label


def synthetic_document(
    maneuvers: Sequence[tuple[str | None, int, float]], *, length_mi: float = 10.0
) -> dict[str, object]:
    """A straight north-south trip: each maneuver is ``(street name, segments, seconds)``.

    Points are 0.01 degree apart so every segment has the same length: the time spreading is then
    exactly predictable.
    """
    segments = sum(count for _, count, _ in maneuvers)
    points = [(40.0 + 0.01 * index, -100.0) for index in range(segments + 1)]
    steps: list[dict[str, object]] = []
    begin = 0
    for name, count, seconds in maneuvers:
        step: dict[str, object] = {
            "begin_shape_index": begin,
            "end_shape_index": begin + count,
            "time": seconds,
            "length": length_mi * count / segments,
        }
        if name is not None:
            step["street_names"] = [name]
        steps.append(step)
        begin += count
    total = sum(seconds for _, _, seconds in maneuvers)
    return {
        "trip": {
            "summary": {"length": length_mi, "time": total},
            "legs": [{"shape": encode_polyline(points, 6), "maneuvers": steps}],
        }
    }


def label_of(maneuvers: Sequence[tuple[str | None, int, float]]) -> str:
    provider = provider_for(respond_with(synthetic_document(maneuvers)), policy=NO_FORCING)
    result = provider.route((-100.0, 40.0), (-100.0, 40.5), load_weight_lb=0)
    return result.routes[0].summary


def test_a_route_is_labelled_by_the_two_roads_it_spends_the_most_distance_on() -> None:
    label = label_of(
        [
            ("Main Street", 1, 30.0),
            ("I 80", 5, 300.0),
            ("Exit Road", 1, 20.0),
            ("I 25 South", 3, 90.0),
        ]
    )

    assert label == "via I-80, I-25"


def test_the_same_road_under_different_spellings_adds_up() -> None:
    label = label_of(
        [("I 25 South", 2, 100.0), ("Side Street", 3, 100.0), ("I 25 North", 2, 100.0)]
    )

    assert label == "via I-25, Side Street"


def test_equally_long_roads_keep_the_order_of_the_route() -> None:
    assert (
        label_of([("A Road", 2, 60.0), ("B Road", 2, 60.0), ("C Road", 2, 60.0)])
        == "via A Road, B Road"
    )


def test_one_named_road_gives_a_one_road_label() -> None:
    assert label_of([(None, 1, 10.0), ("I 80", 4, 100.0)]) == "via I-80"


def test_a_route_without_street_names_gets_the_neutral_label() -> None:
    assert label_of([(None, 3, 100.0)]) == NEUTRAL_LABEL == "via local roads"


def test_names_that_are_not_text_or_normalise_to_nothing_are_ignored() -> None:
    document = synthetic_document([("I 80", 2, 100.0), ("x", 2, 100.0), ("y", 2, 100.0)])
    steps = dig(document, "trip", "legs", 0, "maneuvers")
    assert isinstance(steps, list)
    as_dict(steps[1])["street_names"] = [42]
    as_dict(steps[2])["street_names"] = ["\u0000\u0001"]

    provider = provider_for(respond_with(document), policy=NO_FORCING)
    result = provider.route((-100.0, 40.0), (-100.0, 40.6), load_weight_lb=0)

    assert result.routes[0].summary == "via I-80"


# ----------------------------------------------------------------------- time spreading


def test_a_maneuver_without_length_spreads_its_time_evenly_over_its_points() -> None:
    document = synthetic_document([("A", 4, 400.0)])
    leg_shape = encode_polyline([(40.0, -100.0)] * 5, 6)  # five identical points: zero length
    leg = as_dict(dig(document, "trip", "legs", 0))
    leg["shape"] = leg_shape

    provider = provider_for(respond_with(document), policy=NO_FORCING)
    route = provider.route((-100.0, 40.0), (-100.0, 40.0), load_weight_lb=0).routes[0]

    assert route.cum_s == pytest.approx((0.0, 100.0, 200.0, 300.0, 400.0))


def test_the_time_of_a_zero_length_maneuver_still_delays_what_follows() -> None:
    route = (
        provider_for(
            respond_with(
                synthetic_document([("A", 2, 100.0), ("Ferry", 0, 60.0), ("B", 2, 100.0)])
            ),
            policy=NO_FORCING,
        )
        .route((-100.0, 40.0), (-100.0, 40.04), load_weight_lb=0)
        .routes[0]
    )

    # A takes 100 s, the ferry holds the clock for 60 s at point 2, B starts at 160 s.
    assert route.cum_s == pytest.approx((0.0, 50.0, 100.0, 210.0, 260.0))


@given(
    maneuvers=st.lists(st.tuples(st.integers(1, 6), st.floats(1.0, 600.0)), min_size=1, max_size=8)
)
def test_spreading_keeps_the_clock_monotone_exact_and_proportional(
    maneuvers: list[tuple[int, float]],
) -> None:
    spec = [("Road", count, seconds) for count, seconds in maneuvers]
    document = synthetic_document(spec)
    provider = provider_for(respond_with(document), policy=NO_FORCING)

    route = provider.route((-100.0, 40.0), (-100.0, 40.5), load_weight_lb=0).routes[0]

    assert len(route.cum_s) == len(route.coords)
    assert route.cum_s[0] == 0.0
    assert route.cum_s[-1] == route.duration_s
    assert all(b >= a for a, b in zip(route.cum_s, route.cum_s[1:], strict=False))
    position = 0
    for count, seconds in maneuvers:  # equal segments: equal share of the maneuver's time
        for step in range(count):
            increment = route.cum_s[position + step + 1] - route.cum_s[position + step]
            assert increment == pytest.approx(seconds / count, rel=1e-6, abs=1e-6)
        position += count
