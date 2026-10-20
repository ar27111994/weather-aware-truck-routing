"""Tests of the Valhalla adapter against the real recorded responses of the public server."""

import json
from collections.abc import Callable
from itertools import pairwise

import httpx
import pytest

from haulcast.providers.http import USER_AGENT, HttpPolicy, Pacing, UpstreamClient, build_client
from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.diversity import DiversityPolicy
from haulcast.providers.routing.geometry import haversine_m
from haulcast.providers.routing.throttle import MinIntervalGate
from haulcast.providers.routing.valhalla import (
    CLIENT_ID,
    VALHALLA_URL,
    ValhallaProvider,
    exclusion_ring,
    truck_weight_tonnes,
)
from tests.providers.routing.support import (
    FakeClock,
    as_dict,
    dig,
    exclusion_of,
    fixture_json,
    json_response,
    recorded_forced_calls,
    valhalla_route_coords,
)

SLC: Coordinate = (-111.891, 40.7608)
DEN: Coordinate = (-104.9903, 39.7392)
DAL: Coordinate = (-96.797, 32.7767)
ATL: Coordinate = (-84.388, 33.749)
LAX: Coordinate = (-118.2437, 34.0522)
PHX: Coordinate = (-112.074, 33.4484)
CHI: Coordinate = (-87.6298, 41.8781)

MISSING = object()


class ValhallaDouble:
    """Answers Valhalla requests from recordings and remembers what it was asked.

    The first request (it carries ``alternates``) gets the ``base`` recording; a forced request
    gets the recording whose exclusion matches the request body, so the adapter's anchors are
    checked against the real forced-diversity sequences. An unrecorded forced call is a test
    failure, not an HTTP error: it means the adapter diverged from the recorded sequence.
    """

    def __init__(self, base: str, clock: FakeClock | None = None, call_s: float = 0.0) -> None:
        self.base = base
        self.clock = clock
        self.call_s = call_s
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict[str, object]] = []
        self.times: list[float] = []
        self.forced: list[tuple[str, float, float]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = as_dict(json.loads(request.content))
        self.requests.append(request)
        self.bodies.append(body)
        if self.clock is not None:
            self.times.append(self.clock.now)
            self.clock.advance(self.call_s)
        if "alternates" in body:
            return json_response(self.base)
        variant, lat, lon = exclusion_of(body)
        self.forced.append((variant, lat, lon))
        for recorded in recorded_forced_calls():
            same_anchor = abs(recorded.lat - lat) < 2e-6 and abs(recorded.lon - lon) < 2e-6
            if recorded.variant == variant and same_anchor:
                return json_response(recorded.fixture)
        raise AssertionError(f"no recording for the forced call {variant} at {lat}, {lon}")


def provider_for(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    policy: DiversityPolicy | None = None,
    clock: FakeClock | None = None,
    top_speed_kph: float = 105.0,
) -> ValhallaProvider:
    clock = clock or FakeClock()
    client = UpstreamClient(
        "valhalla",
        client=build_client(transport=httpx.MockTransport(handler)),
        policy=HttpPolicy(max_retries=0, rate_limit_retries=0),
        pacing=Pacing(sleep=clock.sleep, jitter=lambda: 0.0),
    )
    return ValhallaProvider(
        client,
        gate=MinIntervalGate(1.0, clock=clock, sleep=clock.sleep),
        top_speed_kph=top_speed_kph,
        policy=policy or DiversityPolicy(),
        clock=clock,
    )


def trip_of(name: str, index: int = 0) -> dict[str, object]:
    document = fixture_json(name)
    path: tuple[str | int, ...] = ("trip",) if index == 0 else ("alternates", index - 1, "trip")
    return as_dict(dig(document, *path))


# ----------------------------------------------------------------------------- the base call


def test_the_three_routes_of_a_rich_trip_are_returned_in_provider_order() -> None:
    double = ValhallaDouble("valhalla-slc-den-truck-alt2.json")

    result = provider_for(double).route(SLC, DEN, load_weight_lb=38_000)

    assert result.provider == "valhalla"
    assert result.warnings == ()
    assert len(double.requests) == 1  # three distinct routes: no forced diversity needed
    assert [route.summary for route in result.routes] == [
        "via I-80, I-25",
        "via US-40, I-70",
        "via I-70, Highway 6",
    ]
    for index, route in enumerate(result.routes):
        summary = as_dict(trip_of("valhalla-slc-den-truck-alt2.json", index)["summary"])
        assert route.distance_mi == summary["length"]
        assert route.duration_s == summary["time"]
        assert route.coords == valhalla_route_coords("valhalla-slc-den-truck-alt2.json", index)


def test_the_request_is_a_truck_routing_post_with_the_documented_body_and_headers() -> None:
    double = ValhallaDouble("valhalla-slc-den-truck-alt2.json")

    provider_for(double, top_speed_kph=100.0).route(SLC, DEN, load_weight_lb=38_000)

    (request,) = double.requests
    assert (request.method, str(request.url)) == ("POST", VALHALLA_URL)
    assert request.headers["User-Agent"] == USER_AGENT
    assert request.headers["X-Client-Id"] == CLIENT_ID == "haulcast"
    assert double.bodies == [
        {
            "locations": [{"lat": 40.7608, "lon": -111.891}, {"lat": 39.7392, "lon": -104.9903}],
            "costing": "truck",
            "costing_options": {"truck": {"weight": 33.11, "top_speed": 100.0}},
            "alternates": 2,
            "directions_options": {"units": "miles", "language": "en-US"},
            "id": "route",
        }
    ]


@pytest.mark.parametrize(
    ("load_lb", "tonnes"),
    [
        (0, 15.88),  # the empty tractor-trailer: 35,000 lb
        (38_000, 33.11),
        (45_000, 36.29),  # 80,000 lb gross: the US legal limit
        (80_000, 50.0),  # 115,000 lb gross exceeds the 50 t clamp
        (10**9, 50.0),
        (-(10**9), 0.0),
    ],
)
def test_the_truck_weight_is_gross_metric_tonnes_clamped_to_the_servers_range(
    load_lb: int, tonnes: float
) -> None:
    assert truck_weight_tonnes(load_lb) == tonnes


def test_cumulative_seconds_start_at_zero_end_at_the_duration_and_follow_the_maneuvers() -> None:
    result = provider_for(ValhallaDouble("valhalla-slc-den-truck-alt2.json")).route(
        SLC, DEN, load_weight_lb=0
    )

    route = result.routes[0]
    trip = trip_of("valhalla-slc-den-truck-alt2.json")
    first = as_dict(dig(trip, "legs", 0, "maneuvers", 0))
    assert len(route.cum_s) == len(route.coords)
    assert route.cum_s[0] == 0.0
    assert route.cum_s[-1] == route.duration_s
    assert all(
        later >= earlier for earlier, later in zip(route.cum_s, route.cum_s[1:], strict=False)
    )
    end_of_first = first["end_shape_index"]
    assert isinstance(end_of_first, int)
    assert route.cum_s[end_of_first] == pytest.approx(float(str(first["time"])), rel=1e-3)


def test_a_short_urban_trip_is_parsed_like_any_other() -> None:
    result = provider_for(ValhallaDouble("valhalla-newark-jc-truck-alt2.json")).route(
        (-74.1724, 40.7357), (-74.0431, 40.7178), load_weight_lb=20_000
    )

    assert len(result.routes) == 3
    assert result.routes[0].summary == "via Washington Street, NJ-139"


# ------------------------------------------------------------------------ forced diversity


def forced_calls_of(double: ValhallaDouble) -> list[tuple[str, int]]:
    """The forced calls as ``(variant, percent along the route)`` taken from the recordings."""
    names = {
        (call.variant, round(call.lat, 5), round(call.lon, 5)): call.fixture
        for call in recorded_forced_calls()
    }
    calls: list[tuple[str, int]] = []
    for variant, lat, lon in double.forced:
        fixture = names[(variant, round(lat, 5), round(lon, 5))]
        calls.append((variant, int(fixture.split("-")[-2])))
    return calls


def test_dallas_to_atlanta_needs_polygons_and_reaches_three_routes_in_six_forced_calls() -> None:
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")

    result = provider_for(double).route(DAL, ATL, load_weight_lb=38_000)

    assert forced_calls_of(double) == [
        ("loc", 50),  # the same road (overlap 0.986): rejected
        ("poly", 50),  # a real alternative: kept
        ("loc", 25),
        ("poly", 25),  # both return that same alternative again: rejected
        ("loc", 75),
        ("poly", 75),  # the third route
    ]
    assert [round(route.distance_mi, 1) for route in result.routes] == [792.2, 813.3, 812.3]
    assert result.warnings == ()


def test_los_angeles_to_phoenix_needs_two_forced_calls_because_a_success_skips_the_variant() -> (
    None
):
    double = ValhallaDouble("valhalla-la-phx-truck-alt2.json")

    result = provider_for(double).route(LAX, PHX, load_weight_lb=38_000)

    assert forced_calls_of(double) == [("loc", 50), ("loc", 25)]
    assert [round(route.distance_mi, 1) for route in result.routes] == [374.3, 439.2, 407.5]
    assert result.warnings == ()


def test_chicago_to_denver_third_route_passes_at_the_borderline_overlap() -> None:
    double = ValhallaDouble("valhalla-chi-den-truck-alt2.json")

    result = provider_for(double).route(CHI, DEN, load_weight_lb=38_000)

    # 0.5 loc and poly overlap 0.817 with route 1 (duplicates); 0.25 loc is at 0.796 / 0.798.
    assert forced_calls_of(double) == [("loc", 50), ("poly", 50), ("loc", 25)]
    assert [round(route.distance_mi, 1) for route in result.routes] == [1016.4, 1078.9, 1022.3]


def test_a_stricter_threshold_turns_the_borderline_route_into_a_duplicate() -> None:
    double = ValhallaDouble("valhalla-chi-den-truck-alt2.json")
    policy = DiversityPolicy(overlap_threshold=0.79, max_extra_calls=3)

    result = provider_for(double, policy=policy).route(CHI, DEN, load_weight_lb=38_000)

    assert len(result.routes) == 2
    assert [warning.code for warning in result.warnings] == ["fewer_than_3_distinct_routes"]
    assert result.warnings[0].message == "Only 2 distinct routes exist between these places."


def test_forced_requests_have_the_documented_shape_and_stay_under_the_ring_limit() -> None:
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")

    provider_for(double).route(DAL, ATL, load_weight_lb=38_000)

    base, *forced = double.bodies
    assert "alternates" in base
    assert len(forced) == 6
    for body in forced:
        assert set(body) - {"exclude_locations", "exclude_polygons"} == {
            "locations",
            "costing",
            "costing_options",
            "directions_options",
            "id",
        }
        assert body["id"] == "force"
        assert body["costing_options"] == base["costing_options"]  # one cost model for all three
        assert "alternates" not in body
        assert "date_time" not in body
        if "exclude_polygons" in body:
            rings = body["exclude_polygons"]
            assert isinstance(rings, list)
            ring = [(float(point[0]), float(point[1])) for point in rings[0]]
            assert ring[0] == ring[-1]
            assert len(ring) == 5
            perimeter = sum(haversine_m(a, b) for a, b in pairwise(ring))
            assert perimeter < 10_000


@pytest.mark.parametrize("latitude", [-60.0, -33.0, 0.0, 33.0, 41.7, 60.0])
def test_the_excluded_square_is_below_valhallas_perimeter_limit_at_every_latitude(
    latitude: float,
) -> None:
    ring = exclusion_ring((-100.0, latitude), 0.01)

    assert ring[0] == ring[-1]
    assert len(ring) == 5
    perimeter = sum(haversine_m(a, b) for a, b in pairwise(ring))
    assert perimeter < 10_000


def test_without_an_extra_call_budget_a_single_route_is_all_there_is() -> None:
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")

    result = provider_for(double, policy=DiversityPolicy(max_extra_calls=0)).route(
        DAL, ATL, load_weight_lb=38_000
    )

    assert len(double.requests) == 1
    assert len(result.routes) == 1
    assert result.warnings[0].message == "Only 1 distinct route exists between these places."


def test_the_extra_call_budget_is_honoured_exactly() -> None:
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")

    result = provider_for(double, policy=DiversityPolicy(max_extra_calls=2)).route(
        DAL, ATL, load_weight_lb=38_000
    )

    assert forced_calls_of(double) == [("loc", 50), ("poly", 50)]
    assert len(result.routes) == 2
    assert result.warnings[0].message == "Only 2 distinct routes exist between these places."


def test_the_search_ends_when_every_anchor_has_been_tried() -> None:
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    policy = DiversityPolicy(anchor_fractions=(0.5,))

    result = provider_for(double, policy=policy).route(DAL, ATL, load_weight_lb=38_000)

    assert forced_calls_of(double) == [("loc", 50), ("poly", 50)]
    assert len(result.routes) == 2
    assert result.warnings[0].message == "Only 2 distinct routes exist between these places."


def test_no_extra_call_starts_after_the_stage_budget_is_spent() -> None:
    clock = FakeClock()
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json", clock=clock, call_s=12.0)

    result = provider_for(double, policy=DiversityPolicy(stage_budget_s=15.0), clock=clock).route(
        DAL, ATL, load_weight_lb=38_000
    )

    # base call: 12 s; first forced call starts at 12 s (< 15) and ends at 25 s: no more.
    assert [variant for variant, _, _ in double.forced] == ["loc"]
    assert len(result.routes) == 1
    assert result.warnings[0].code == "fewer_than_3_distinct_routes"


def test_calls_are_strictly_sequential_and_at_least_a_second_apart() -> None:
    clock = FakeClock()
    double = ValhallaDouble("valhalla-dal-atl-truck-alt2.json", clock=clock, call_s=0.2)

    provider_for(double, clock=clock).route(DAL, ATL, load_weight_lb=38_000)

    assert len(double.times) == 7
    gaps = [later - earlier for earlier, later in zip(double.times, double.times[1:], strict=False)]
    assert all(gap >= 1.0 - 1e-9 for gap in gaps)


def spoil_first_polygon_call(
    inner: ValhallaDouble, spoiled: Callable[[], httpx.Response]
) -> Callable[[httpx.Request], httpx.Response]:
    """Answer the first ``exclude_polygons`` request (the one that would succeed) with a failure."""
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = as_dict(json.loads(request.content))
        if "exclude_polygons" in body and not seen:
            seen.append(1)
            return spoiled()
        return inner(request)

    return handler


def test_a_forced_call_the_server_rejects_is_skipped_and_the_search_continues() -> None:
    inner = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    rejected = spoil_first_polygon_call(
        inner, lambda: json_response("valhalla-slc-den-exclude-poly-0.1.json", status=400)
    )

    result = provider_for(rejected).route(DAL, ATL, load_weight_lb=38_000)

    # poly at 50 % was refused (HTTP 400, error 167) and never reached the recording; the search
    # went on: the 25 % location found that road, then the 75 % polygon found the third route.
    assert [(variant, round(lat, 3)) for variant, lat, _ in inner.forced] == [
        ("loc", 32.313),
        ("loc", 32.542),
        ("loc", 33.176),
        ("poly", 33.176),
    ]
    assert [round(route.distance_mi, 1) for route in result.routes] == [792.2, 813.3, 812.3]


def test_a_forced_call_with_a_garbled_answer_is_skipped_too() -> None:
    inner = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    garbled = spoil_first_polygon_call(
        inner, lambda: httpx.Response(200, content=b"<html>maintenance</html>")
    )

    result = provider_for(garbled).route(DAL, ATL, load_weight_lb=38_000)

    assert len(inner.forced) == 4
    assert len(result.routes) == 3


def test_when_the_server_struggles_the_search_stops_and_keeps_what_it_has() -> None:
    inner = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    forced_attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = as_dict(json.loads(request.content))
        if "alternates" in body:
            return inner(request)
        forced_attempts.append(1)
        return httpx.Response(503)

    result = provider_for(handler).route(DAL, ATL, load_weight_lb=38_000)

    assert forced_attempts == [1]  # an overloaded server is not hammered with more variants
    assert len(result.routes) == 1
    assert result.warnings[0].message == "Only 1 distinct route exists between these places."


def test_a_rate_limited_forced_call_also_ends_the_search() -> None:
    inner = ValhallaDouble("valhalla-dal-atl-truck-alt2.json")
    forced_attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = as_dict(json.loads(request.content))
        if "alternates" in body:
            return inner(request)
        forced_attempts.append(1)
        return httpx.Response(429)

    result = provider_for(handler).route(DAL, ATL, load_weight_lb=38_000)

    assert forced_attempts == [1]
    assert len(result.routes) == 1
