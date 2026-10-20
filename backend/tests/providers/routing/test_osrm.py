"""Tests of the OSRM adapter against the real recorded responses of the public demo server."""

import copy
import json
import math
from collections.abc import Callable

import httpx
import pytest

from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.http import USER_AGENT, HttpPolicy, UpstreamClient, build_client
from haulcast.providers.routing.base import Coordinate, NoRouteFoundError, RoutingResult
from haulcast.providers.routing.diversity import DiversityPolicy
from haulcast.providers.routing.osrm import OSRM_URL, OsrmProvider
from haulcast.providers.routing.polyline import decode_polyline
from haulcast.providers.routing.throttle import MinIntervalGate
from tests.providers.routing.support import (
    FakeClock,
    as_dict,
    dig,
    encode_polyline,
    fixture_json,
    json_response,
    lonlat,
)

SLC: Coordinate = (-111.891, 40.7608)
DEN: Coordinate = (-104.9903, 39.7392)
LAX: Coordinate = (-118.2437, 34.0522)
NYC: Coordinate = (-74.0060, 40.7128)
METERS_PER_MILE = 1609.344
MISSING = object()


def provider_for(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    clock: FakeClock | None = None,
    top_speed_kph: float = 105.0,
    policy: DiversityPolicy | None = None,
) -> OsrmProvider:
    clock = clock or FakeClock()
    client = UpstreamClient(
        "osrm",
        client=build_client(transport=httpx.MockTransport(handler)),
        policy=HttpPolicy(max_retries=0, rate_limit_retries=0),
        sleep=clock.sleep,
        random_fn=lambda: 0.0,
    )
    return OsrmProvider(
        client,
        gate=MinIntervalGate(1.0, clock=clock, sleep=clock.sleep),
        top_speed_kph=top_speed_kph,
        policy=policy or DiversityPolicy(),
    )


def recorded(name: str) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _request: json_response(name)


def respond_with(document: object, status: int = 200) -> Callable[[httpx.Request], httpx.Response]:
    """Answer every request with ``document``; ``NaN`` / ``Infinity`` pass, as in Python JSON."""
    body = json.dumps(document).encode()
    return lambda _request: httpx.Response(
        status, content=body, headers={"content-type": "application/json"}
    )


def route_of(document: object, index: int = 0) -> dict[str, object]:
    return as_dict(dig(document, "routes", index))


def synthetic_route(
    points: list[tuple[float, float]],
    durations: list[float],
    distances: list[float],
    *,
    duration: float | None = None,
    distance: float | None = None,
) -> dict[str, object]:
    """One OSRM route over ``(lat, lon)`` points with per-segment annotations."""
    return {
        "geometry": encode_polyline(points, 6),
        "duration": sum(durations) if duration is None else duration,
        "distance": sum(distances) if distance is None else distance,
        "legs": [{"annotation": {"duration": durations, "distance": distances}}],
    }


def synthetic_document(*routes: dict[str, object]) -> dict[str, object]:
    return {"code": "Ok", "routes": list(routes)}


def meridian_route(lon: float, lat_from: float = 40.0, lat_to: float = 41.0) -> dict[str, object]:
    """A 1,000-segment route along a meridian at 20 m/s (72 km/h, below the speed cap)."""
    count = 100
    step = (lat_to - lat_from) / count
    points = [(lat_from + step * index, lon) for index in range(count + 1)]
    metres = 111_195.0 * step
    return synthetic_route(points, [metres / 20.0] * count, [metres] * count)


def route_between(document: object, provider: OsrmProvider | None = None) -> RoutingResult:
    provider = provider or provider_for(respond_with(document))
    return provider.route((-100.0, 40.0), (-100.0, 41.0), load_weight_lb=0)


# ------------------------------------------------------------------------------ requests


def test_the_request_is_a_car_routing_get_with_the_documented_parameters() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return json_response("osrm-slc-den-alt3.json")

    provider_for(handler).route(SLC, DEN, load_weight_lb=38_000)

    (request,) = seen
    assert request.method == "GET"
    assert str(request.url).startswith(f"{OSRM_URL}/-111.891000,40.760800;-104.990300,39.739200?")
    assert dict(request.url.params) == {
        "alternatives": "3",
        "overview": "full",
        "geometries": "polyline6",
        "steps": "false",
        "annotations": "duration,distance",
    }
    assert request.headers["User-Agent"] == USER_AGENT


def test_the_profile_is_always_driving_and_the_load_is_ignored() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return json_response("osrm-slc-den-alt3.json")

    provider = provider_for(handler)
    provider.route(SLC, DEN, load_weight_lb=0)
    provider.route(SLC, DEN, load_weight_lb=80_000)

    assert seen[0] == seen[1]
    assert seen[0].startswith("/route/v1/driving/")


def test_tiny_coordinates_are_never_written_in_exponent_notation() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return json_response("osrm-slc-den-alt3.json")

    provider_for(handler).route((-0.00001, 0.00001), (1e-7, -1e-7), load_weight_lb=0)

    assert seen == ["/route/v1/driving/-0.000010,0.000010;0.000000,-0.000000"]


def test_calls_are_at_least_a_second_apart() -> None:
    clock = FakeClock()
    times: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        times.append(clock.now)
        return json_response("osrm-slc-den-alt3.json")

    provider = provider_for(handler, clock=clock)
    provider.route(SLC, DEN, load_weight_lb=0)
    clock.advance(0.1)
    provider.route(SLC, DEN, load_weight_lb=0)

    assert times[1] - times[0] >= 1.0 - 1e-9


# --------------------------------------------------------------------- recorded routes


@pytest.mark.parametrize(
    ("name", "count"),
    [
        ("osrm-slc-den-alt3.json", 1),
        ("osrm-chi-den-alt3.json", 2),
        ("osrm-dal-atl-alt3.json", 2),
        ("osrm-la-phx-alt3.json", 1),
        ("osrm-newark-jc-alt3.json", 2),
        ("osrm-la-nyc-alt3.json", 2),
    ],
)
def test_the_recorded_trips_yield_their_distinct_routes_with_a_consistent_clock(
    name: str, count: int
) -> None:
    document = fixture_json(name)

    result = provider_for(recorded(name)).route(SLC, DEN, load_weight_lb=38_000)

    assert result.provider == "osrm"
    assert len(result.routes) == count
    for index, route in enumerate(result.routes):
        raw = route_of(document, index)
        shape = raw["geometry"]
        assert isinstance(shape, str)
        assert route.coords == lonlat(decode_polyline(shape, 6))
        assert route.distance_mi == pytest.approx(float(str(raw["distance"])) / METERS_PER_MILE)
        assert len(route.cum_s) == len(route.coords)
        assert route.cum_s[0] == 0.0
        assert route.cum_s[-1] == route.duration_s
        assert all(b >= a for a, b in zip(route.cum_s, route.cum_s[1:], strict=False))
        # the cap can only slow a route down, and car speeds are mostly below it
        stated = float(str(raw["duration"]))
        assert stated - 1e-6 <= route.duration_s <= stated * 1.05
        assert route.summary == f"Car route {index + 1}"


def test_a_trip_with_fewer_than_three_routes_carries_the_warning() -> None:
    result = provider_for(recorded("osrm-chi-den-alt3.json")).route(SLC, DEN, load_weight_lb=0)

    assert [warning.code for warning in result.warnings] == ["fewer_than_3_distinct_routes"]
    assert result.warnings[0].message == "Only 2 distinct routes exist between these places."


def test_the_long_recorded_route_is_parsed_whole() -> None:
    result = provider_for(recorded("osrm-la-nyc-alt3.json")).route(LAX, NYC, load_weight_lb=38_000)

    assert result.routes[0].distance_mi == pytest.approx(2793.7, abs=0.1)
    assert len(result.routes[0].coords) > 4_000


def test_a_lower_top_speed_stretches_the_recorded_clock() -> None:
    raw = route_of(fixture_json("osrm-slc-den-alt3.json"))
    metres = float(str(raw["distance"]))

    result = provider_for(recorded("osrm-slc-den-alt3.json"), top_speed_kph=60.0).route(
        SLC, DEN, load_weight_lb=0
    )

    assert result.routes[0].duration_s >= metres / (60.0 / 3.6) - 1e-6


# ---------------------------------------------------------------------------- the clock


def test_no_stretch_of_road_is_faster_than_the_top_speed() -> None:
    # 11.12 km annotated as 60 s (185 m/s): capped at 105 km/h = 29.17 m/s
    document = synthetic_document(
        synthetic_route([(40.0, -100.0), (40.1, -100.0)], [60.0], [11_119.5])
    )

    (route,) = route_between(document).routes

    assert route.cum_s == pytest.approx((0.0, 11_119.5 / (105.0 / 3.6)))
    assert route.duration_s == pytest.approx(11_119.5 / (105.0 / 3.6))


def test_slower_stretches_keep_their_annotated_time() -> None:
    document = synthetic_document(
        synthetic_route(
            [(40.0, -100.0), (40.1, -100.0), (40.2, -100.0)],
            [60.0, 600.0],  # the second is 11.12 km in 600 s: 18.5 m/s
            [11_119.5, 11_119.5],
        )
    )

    (route,) = route_between(document).routes

    assert route.cum_s == pytest.approx(
        (0.0, 11_119.5 / (105.0 / 3.6), 11_119.5 / (105.0 / 3.6) + 600.0)
    )


def test_the_annotated_clock_is_scaled_to_the_routes_own_duration_first() -> None:
    # annotations add up to 600 s but OSRM says the route takes 660 s (turn penalties)
    document = synthetic_document(
        synthetic_route(
            [(40.0, -100.0), (40.05, -100.0), (40.1, -100.0)],
            [300.0, 300.0],
            [5_560.0, 5_560.0],
            duration=660.0,
        )
    )

    (route,) = route_between(document).routes

    assert route.cum_s == pytest.approx((0.0, 330.0, 660.0))
    assert route.duration_s == pytest.approx(660.0)


def test_a_zero_duration_segment_is_still_bounded_by_the_top_speed() -> None:
    document = synthetic_document(
        synthetic_route(
            [(40.0, -100.0), (40.05, -100.0), (40.1, -100.0)],
            [0.0, 600.0],
            [5_560.0, 5_560.0],
        )
    )

    (route,) = route_between(document).routes

    assert route.cum_s[1] == pytest.approx(5_560.0 / (105.0 / 3.6))


def test_a_zero_length_zero_duration_segment_costs_nothing() -> None:
    document = synthetic_document(
        synthetic_route(
            [(40.0, -100.0), (40.0, -100.0), (40.1, -100.0)],
            [0.0, 600.0],
            [0.0, 11_119.5],
        )
    )

    (route,) = route_between(document).routes

    assert route.cum_s[:2] == (0.0, 0.0)


# ------------------------------------------------------------------------- distinctness


def test_near_identical_alternatives_are_dropped() -> None:
    document = synthetic_document(meridian_route(-100.0), meridian_route(-100.0))

    result = route_between(document)

    assert len(result.routes) == 1


def test_three_distant_routes_need_no_warning() -> None:
    document = synthetic_document(
        meridian_route(-100.0), meridian_route(-99.9), meridian_route(-100.1)
    )

    result = route_between(document)

    assert len(result.routes) == 3
    assert result.warnings == ()
    assert [route.summary for route in result.routes] == [
        "Car route 1",
        "Car route 2",
        "Car route 3",
    ]


# --------------------------------------------------------------------------------- errors


def test_osrm_answers_no_route_with_http_200_and_a_code() -> None:
    with pytest.raises(NoRouteFoundError):
        provider_for(recorded("osrm-error-no-route.json")).route(SLC, DEN, load_weight_lb=0)


def test_a_point_that_cannot_be_snapped_to_a_road_is_no_route_too() -> None:
    with pytest.raises(NoRouteFoundError):
        provider_for(respond_with({"code": "NoSegment", "message": "x"})).route(
            SLC, DEN, load_weight_lb=0
        )


def test_a_rejected_query_is_a_rejection() -> None:
    handler = respond_with(fixture_json("osrm-error-bad-param.json"), status=400)

    with pytest.raises(ProviderRejectedError) as excinfo:
        provider_for(handler).route(SLC, DEN, load_weight_lb=0)

    assert excinfo.value.code == "InvalidQuery"


def test_server_errors_rate_limits_and_timeouts_are_typed() -> None:
    with pytest.raises(ProviderRateLimitedError):
        provider_for(lambda _request: httpx.Response(429)).route(SLC, DEN, load_weight_lb=0)
    with pytest.raises(ProviderUnavailableError):
        provider_for(lambda _request: httpx.Response(502)).route(SLC, DEN, load_weight_lb=0)

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    with pytest.raises(ProviderUnavailableError):
        provider_for(timeout).route(SLC, DEN, load_weight_lb=0)


def with_value(document: object, path: tuple[str | int, ...], value: object) -> object:
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


GOOD = synthetic_document(meridian_route(-100.0))
ROUTE = ("routes", 0)
BAD_DOCUMENTS = {
    "root-is-a-list": ((), []),
    "unknown-code": (("code",), "InvalidValue"),
    "code-missing": (("code",), MISSING),
    "routes-missing": (("routes",), MISSING),
    "routes-empty": (("routes",), []),
    "route-not-an-object": ((*ROUTE,), "route"),
    "distance-is-text": ((*ROUTE, "distance"), "10"),
    "distance-zero": ((*ROUTE, "distance"), 0.0),
    "distance-negative": ((*ROUTE, "distance"), -4.0),
    "distance-nan": ((*ROUTE, "distance"), math.nan),
    "duration-zero": ((*ROUTE, "duration"), 0.0),
    "duration-bool": ((*ROUTE, "duration"), True),
    "geometry-missing": ((*ROUTE, "geometry"), MISSING),
    "geometry-not-text": ((*ROUTE, "geometry"), 5),
    "geometry-bad-alphabet": ((*ROUTE, "geometry"), "!!!!"),
    "geometry-one-point": ((*ROUTE, "geometry"), encode_polyline([(40.0, -100.0)], 6)),
    "geometry-off-the-globe": (
        (*ROUTE, "geometry"),
        encode_polyline([(95.0, -100.0), (96.0, -100.0)], 6),
    ),
    "legs-missing": ((*ROUTE, "legs"), MISSING),
    "legs-empty": ((*ROUTE, "legs"), []),
    "leg-not-an-object": ((*ROUTE, "legs", 0), 1),
    "annotation-missing": ((*ROUTE, "legs", 0, "annotation"), MISSING),
    "annotation-durations-missing": ((*ROUTE, "legs", 0, "annotation", "duration"), MISSING),
    "annotation-distances-not-a-list": ((*ROUTE, "legs", 0, "annotation", "distance"), "far"),
    "annotation-too-short": ((*ROUTE, "legs", 0, "annotation", "duration"), [1.0, 2.0]),
    "annotation-negative": ((*ROUTE, "legs", 0, "annotation", "duration", 3), -1.0),
    "annotation-text": ((*ROUTE, "legs", 0, "annotation", "distance", 3), "x"),
    "annotation-all-zero": ((*ROUTE, "legs", 0, "annotation", "duration"), [0.0] * 100),
    "route-duration-wildly-off": ((*ROUTE, "duration"), 1.0),
}


@pytest.mark.parametrize(("path", "value"), list(BAD_DOCUMENTS.values()), ids=list(BAD_DOCUMENTS))
def test_inconsistent_documents_are_refused_not_repaired(
    path: tuple[str | int, ...], value: object
) -> None:
    document = value if not path else with_value(GOOD, path, value)

    with pytest.raises(ProviderResponseError):
        route_between(document)


def test_an_answer_that_is_not_json_is_a_response_error() -> None:
    def html(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>demo server maintenance</html>")

    with pytest.raises(ProviderResponseError):
        provider_for(html).route(SLC, DEN, load_weight_lb=0)
