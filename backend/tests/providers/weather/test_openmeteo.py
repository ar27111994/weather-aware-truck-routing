"""Tests of the Open-Meteo adapter: real recorded responses served through respx, no network."""

import copy
import hashlib
import json
import math
import re
from collections.abc import Callable, Iterator, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.http import Pacing, UpstreamClient, build_client
from haulcast.providers.weather.base import (
    VARIABLES,
    HourlyForecast,
    HourWindow,
    LatticePoint,
    WeatherProvider,
    snap_to_lattice,
)
from haulcast.providers.weather.openmeteo import (
    DEFAULT_CHUNK_SIZE,
    DEFAULT_URL,
    MAX_LOCATIONS_PER_REQUEST,
    OPENMETEO_ATTRIBUTION,
    UNIT_PARAMETERS,
    VARIABLE_SET_HASH,
    OpenMeteoProvider,
    variable_set_hash,
)

URL = "https://api.open-meteo.com/v1/forecast"
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "providers" / "weather"
DENVER_FILE = "openmeteo-denver-gmt-start-end-hour.json"
MULTI_FILE = "openmeteo-multi-3loc-gmt.json"
POST_FILE = "openmeteo-600loc-post.json"
WRONG_UNITS_FILE = "openmeteo-post-form-3loc.json"
SNOW_FILE = "openmeteo-snow-sites-inch-units.json"

DENVER = snap_to_lattice(39.7392, -104.9903)
SALT_LAKE = snap_to_lattice(40.7608, -111.8910)
CHICAGO = snap_to_lattice(41.8781, -87.6298)
DENVER_START = datetime(2026, 10, 20, 14, tzinfo=UTC)
DENVER_WINDOW = HourWindow(DENVER_START, 49)
MULTI_WINDOW = HourWindow(datetime(2026, 10, 19, 21, tzinfo=UTC), 6)
POST_WINDOW = HourWindow(datetime(2026, 10, 19, 21, tzinfo=UTC), 49)

JsonObject = dict[str, object]
Mutation = Callable[[JsonObject], None]
Columns = dict[str, Sequence[float | None]]

# The unit labels Open-Meteo really returned for our request (note ``mp/h``).
RECORDED_UNITS = {
    "time": "unixtime",
    "wind_speed_10m": "mp/h",
    "wind_gusts_10m": "mp/h",
    "rain": "inch",
    "showers": "inch",
    "snowfall": "inch",
    "precipitation": "inch",
    "temperature_2m": "\u00b0F",
    "weather_code": "wmo code",
}


# --------------------------------------------------------------------------- helpers


def obj(value: object) -> JsonObject:
    assert isinstance(value, dict)
    return value


def arr(value: object) -> list[object]:
    assert isinstance(value, list)
    return value


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def fixture(name: str) -> object:
    return json.loads(fixture_bytes(name))


def recorded_denver() -> JsonObject:
    return obj(fixture(DENVER_FILE))


def recorded_list(name: str) -> list[JsonObject]:
    return [obj(item) for item in arr(fixture(name))]


def ok(payload: object) -> httpx.Response:
    """Serve ``payload`` as JSON text; unlike ``json=`` this lets NaN and Infinity through."""
    return httpx.Response(
        200,
        content=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )


def numbers(values: object) -> tuple[float | None, ...]:
    """Return the JSON array ``values`` as floats, keeping nulls."""
    result: list[float | None] = []
    for value in arr(values):
        if value is None:
            result.append(None)
        else:
            assert isinstance(value, int | float)
            result.append(float(value))
    return tuple(result)


def recorded_columns(item: JsonObject) -> Columns:
    hourly = obj(item["hourly"])
    return {name: numbers(hourly[name]) for name in VARIABLES}


def columns(forecast: HourlyForecast) -> Columns:
    return {
        "wind_speed_10m": forecast.wind_speed_mph,
        "wind_gusts_10m": forecast.wind_gust_mph,
        "rain": forecast.rain_in,
        "showers": forecast.showers_in,
        "snowfall": forecast.snowfall_in,
        "precipitation": forecast.precipitation_in,
        "temperature_2m": forecast.temperature_f,
        "weather_code": forecast.weather_code,
    }


def form_of(request: httpx.Request) -> dict[str, str]:
    parsed = parse_qs(request.content.decode("ascii"), keep_blank_values=True, strict_parsing=True)
    assert all(len(values) == 1 for values in parsed.values())
    return {name: values[0] for name, values in parsed.items()}


def cells_of(request: httpx.Request) -> list[tuple[str, str]]:
    form = form_of(request)
    return list(zip(form["latitude"].split(","), form["longitude"].split(","), strict=True))


def select_hours(item: JsonObject, indexes: Sequence[int]) -> JsonObject:
    """Return a copy of ``item`` whose hourly arrays hold only ``indexes``, in that order."""
    chosen = copy.deepcopy(item)
    hourly = obj(chosen["hourly"])
    for name in list(hourly):
        column = arr(hourly[name])
        hourly[name] = [column[index] for index in indexes]
    return chosen


def retimed(item: JsonObject, start: datetime) -> JsonObject:
    """Return a copy of ``item`` whose time axis starts at ``start``, hour by hour."""
    moved = copy.deepcopy(item)
    hourly = obj(moved["hourly"])
    first = int(start.timestamp())
    hourly["time"] = [first + 3_600 * index for index in range(len(arr(hourly["time"])))]
    return moved


def mutated(item: JsonObject, *mutations: Mutation) -> JsonObject:
    damaged = copy.deepcopy(item)
    for mutation in mutations:
        mutation(damaged)
    return damaged


def cell_set(name: str, index: int, value: object) -> Mutation:
    def mutation(item: JsonObject) -> None:
        arr(obj(item["hourly"])[name])[index] = value

    return mutation


def hourly_set(name: str, value: object) -> Mutation:
    def mutation(item: JsonObject) -> None:
        obj(item["hourly"])[name] = value

    return mutation


def hourly_del(name: str) -> Mutation:
    def mutation(item: JsonObject) -> None:
        del obj(item["hourly"])[name]

    return mutation


def item_set(key: str, value: object) -> Mutation:
    def mutation(item: JsonObject) -> None:
        item[key] = value

    return mutation


def item_del(key: str) -> Mutation:
    def mutation(item: JsonObject) -> None:
        del item[key]

    return mutation


def units_set(name: str, value: object) -> Mutation:
    def mutation(item: JsonObject) -> None:
        obj(item["hourly_units"])[name] = value

    return mutation


def units_del(name: str) -> Mutation:
    def mutation(item: JsonObject) -> None:
        del obj(item["hourly_units"])[name]

    return mutation


def echo_cells(template: JsonObject) -> Callable[[httpx.Request], httpx.Response]:
    """Answer like Open-Meteo: one item per requested location, an object for a single one.

    Each item is a copy of the real ``template`` whose grid cell is the requested coordinate
    shifted by a fixed offset, so the tests can tell which request cell every forecast answers.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        items: list[JsonObject] = []
        for lat, lon in cells_of(request):
            item = copy.deepcopy(template)
            item["latitude"] = float(lat) + 0.0123
            item["longitude"] = float(lon) - 0.0123
            items.append(item)
        return ok(items[0] if len(items) == 1 else items)

    return handler


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    with respx.MockRouter(assert_all_called=False) as mock:
        yield mock


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def http_client() -> Iterator[httpx.Client]:
    with build_client() as client:
        yield client


@pytest.fixture
def upstream(http_client: httpx.Client, sleeps: list[float]) -> UpstreamClient:
    return UpstreamClient(
        "open-meteo",
        client=http_client,
        pacing=Pacing(sleep=sleeps.append, jitter=lambda: 0.0),
    )


@pytest.fixture
def provider(upstream: UpstreamClient) -> OpenMeteoProvider:
    return OpenMeteoProvider(upstream)


# --------------------------------------------------------------------------- fixtures sanity


def test_the_recorded_units_are_exactly_the_labels_the_adapter_insists_on() -> None:
    assert recorded_denver()["hourly_units"] == RECORDED_UNITS


@pytest.mark.parametrize(
    ("name", "window"),
    [(DENVER_FILE, DENVER_WINDOW), (MULTI_FILE, MULTI_WINDOW), (POST_FILE, POST_WINDOW)],
)
def test_the_windows_used_below_match_the_recorded_time_axes(name: str, window: HourWindow) -> None:
    recorded = fixture(name)
    items = [obj(recorded)] if isinstance(recorded, dict) else [obj(i) for i in arr(recorded)]
    for item in items:
        times = arr(obj(item["hourly"])["time"])
        assert times[0] == int(window.start.timestamp())
        assert times[-1] == int(window.end.timestamp())
        assert len(times) == window.hours


# --------------------------------------------------------------------------- request


def test_one_location_is_one_form_post_with_exactly_the_documented_parameters(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    route = router.post(URL).mock(return_value=ok(recorded_denver()))

    provider.fetch([DENVER], DENVER_WINDOW)

    assert route.call_count == 1
    request = route.calls.last.request
    assert request.method == "POST"
    assert str(request.url) == URL
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert form_of(request) == {
        "latitude": "39.7",
        "longitude": "-105.0",
        "hourly": "wind_speed_10m,wind_gusts_10m,rain,showers,snowfall,precipitation,"
        "temperature_2m,weather_code",
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "temperature_unit": "fahrenheit",
        "timeformat": "unixtime",
        "timezone": "GMT",
        "start_hour": "2026-10-20T14:00",
        "end_hour": "2026-10-22T14:00",
    }


def test_the_request_identifies_the_application(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    route = router.post(URL).mock(return_value=ok(recorded_denver()))

    provider.fetch([DENVER], DENVER_WINDOW)

    assert route.calls.last.request.headers["user-agent"].startswith("Haulcast/")


def test_several_locations_are_comma_joined_in_request_order_with_one_decimal(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    route = router.post(URL).mock(return_value=ok(recorded_list(MULTI_FILE)))

    provider.fetch([SALT_LAKE, DENVER, CHICAGO], MULTI_WINDOW)

    form = form_of(route.calls.last.request)
    assert form["latitude"] == "40.8,39.7,41.9"
    assert form["longitude"] == "-111.9,-105.0,-87.6"
    assert (form["start_hour"], form["end_hour"]) == ("2026-10-19T21:00", "2026-10-20T02:00")


def test_the_window_bounds_are_inclusive_utc_hours_across_a_year_end(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    window = HourWindow(datetime(2026, 12, 31, 23, tzinfo=UTC), 3)
    answer = retimed(select_hours(recorded_denver(), [0, 1, 2]), window.start)
    route = router.post(URL).mock(return_value=ok(answer))

    provider.fetch([DENVER], window)

    form = form_of(route.calls.last.request)
    assert (form["start_hour"], form["end_hour"]) == ("2026-12-31T23:00", "2027-01-01T01:00")
    assert not {"forecast_hours", "past_hours", "forecast_days"} & form.keys()


def test_duplicate_points_are_requested_once_in_first_seen_order(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    salt_lake, denver, _chicago = recorded_list(MULTI_FILE)
    route = router.post(URL).mock(return_value=ok([denver, salt_lake]))

    result = provider.fetch([DENVER, SALT_LAKE, DENVER, SALT_LAKE, DENVER], MULTI_WINDOW)

    assert form_of(route.calls.last.request)["latitude"] == "39.7,40.8"
    assert list(result) == [DENVER, SALT_LAKE]
    assert result[DENVER].source_lat == 39.746895
    assert result[SALT_LAKE].source_lat == 40.746216


def test_no_points_means_an_empty_mapping_and_no_request(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    route = router.post(URL).mock(return_value=ok(recorded_denver()))

    assert provider.fetch([], DENVER_WINDOW) == {}
    assert not route.called


def test_a_custom_url_is_used(router: respx.MockRouter, upstream: UpstreamClient) -> None:
    custom = "https://customer-api.open-meteo.com/v1/forecast"
    route = router.post(custom).mock(return_value=ok(recorded_denver()))

    OpenMeteoProvider(upstream, url=custom).fetch([DENVER], DENVER_WINDOW)

    assert route.call_count == 1


def test_defaults_match_the_researched_upstream_limits() -> None:
    assert DEFAULT_URL == URL
    assert DEFAULT_CHUNK_SIZE == 250
    assert MAX_LOCATIONS_PER_REQUEST == 1000


# --------------------------------------------------------------------------- chunking


def test_six_hundred_points_are_fetched_in_chunks_of_250_250_100_in_order(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    template = recorded_list(POST_FILE)[0]
    route = router.post(URL).mock(side_effect=echo_cells(template))
    points = [LatticePoint(300 + index // 40, -1000 - index % 40) for index in range(600)]

    result = provider.fetch(points, POST_WINDOW)

    assert [len(cells_of(call.request)) for call in route.calls] == [250, 250, 100]
    requested = [cell for call in route.calls for cell in cells_of(call.request)]
    assert requested == [(f"{p.lat:.1f}", f"{p.lon:.1f}") for p in points]
    assert list(result) == points
    for point in points:
        forecast = result[point]
        assert forecast.source_lat == pytest.approx(point.lat + 0.0123)
        assert forecast.source_lon == pytest.approx(point.lon - 0.0123)
        assert forecast.point == point
        assert forecast.window == POST_WINDOW


def test_a_trailing_single_location_chunk_is_answered_with_an_object(
    router: respx.MockRouter, upstream: UpstreamClient
) -> None:
    template = recorded_list(POST_FILE)[0]
    route = router.post(URL).mock(side_effect=echo_cells(template))
    points = [LatticePoint(400, -1000 - index) for index in range(5)]

    result = OpenMeteoProvider(upstream, chunk_size=2).fetch(points, POST_WINDOW)

    assert [len(cells_of(call.request)) for call in route.calls] == [2, 2, 1]
    assert list(result) == points
    assert result[points[4]].source_lat == pytest.approx(points[4].lat + 0.0123)


def test_duplicates_are_removed_before_the_points_are_split_into_chunks(
    router: respx.MockRouter, upstream: UpstreamClient
) -> None:
    template = recorded_list(POST_FILE)[0]
    route = router.post(URL).mock(side_effect=echo_cells(template))
    a, b, c = (LatticePoint(400, -1000 - index) for index in range(3))

    result = OpenMeteoProvider(upstream, chunk_size=2).fetch([a, b, a, c, b], POST_WINDOW)

    assert [len(cells_of(call.request)) for call in route.calls] == [2, 1]
    assert list(result) == [a, b, c]


def test_a_failing_chunk_fails_the_whole_fetch_instead_of_returning_a_partial_result(
    router: respx.MockRouter, upstream: UpstreamClient
) -> None:
    route = router.post(URL).mock(
        side_effect=[
            ok(recorded_list(MULTI_FILE)[:2]),
            httpx.Response(503),
            httpx.Response(503),
            httpx.Response(503),
        ]
    )
    provider = OpenMeteoProvider(upstream, chunk_size=2)

    with pytest.raises(ProviderUnavailableError, match="HTTP 503"):
        provider.fetch([SALT_LAKE, DENVER, CHICAGO], MULTI_WINDOW)

    assert route.call_count == 4


@pytest.mark.parametrize("chunk_size", [0, -1, MAX_LOCATIONS_PER_REQUEST + 1])
def test_a_chunk_size_outside_the_upstream_limit_is_refused(
    upstream: UpstreamClient, chunk_size: int
) -> None:
    with pytest.raises(ValueError, match="chunk_size"):
        OpenMeteoProvider(upstream, chunk_size=chunk_size)


@pytest.mark.parametrize("chunk_size", [1, MAX_LOCATIONS_PER_REQUEST])
def test_the_smallest_and_largest_chunk_sizes_are_accepted(
    upstream: UpstreamClient, chunk_size: int
) -> None:
    assert OpenMeteoProvider(upstream, chunk_size=chunk_size).model == "best_match"


# --------------------------------------------------------------------------- mapping


def test_a_single_location_object_becomes_the_recorded_forecast(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=ok(recorded_denver()))

    result = provider.fetch([DENVER], DENVER_WINDOW)

    assert list(result) == [DENVER]
    forecast = result[DENVER]
    assert forecast.point == DENVER
    assert forecast.model == "best_match"
    assert forecast.start == DENVER_START
    assert forecast.window == DENVER_WINDOW
    assert forecast.hours == 49
    assert (forecast.source_lat, forecast.source_lon) == (39.746895, -104.987076)
    assert forecast.elevation_m == 1599.0
    assert columns(forecast) == recorded_columns(recorded_denver())


def test_a_location_list_maps_item_by_item_to_the_requested_points(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    points = [SALT_LAKE, DENVER, CHICAGO]
    items = recorded_list(MULTI_FILE)
    router.post(URL).mock(return_value=ok(items))

    result = provider.fetch(points, MULTI_WINDOW)

    assert list(result) == points
    for point, item in zip(points, items, strict=True):
        forecast = result[point]
        assert forecast.point == point
        assert forecast.window == MULTI_WINDOW
        assert (forecast.source_lat, forecast.source_lon) == (item["latitude"], item["longitude"])
        assert forecast.elevation_m == item["elevation"]
        assert columns(forecast) == recorded_columns(item)


def test_a_real_form_post_response_maps_the_same_way(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    points = [LatticePoint(476, -1223), LatticePoint(476, -1222)]
    items = recorded_list(POST_FILE)
    router.post(URL).mock(return_value=ok(items))

    result = provider.fetch(points, POST_WINDOW)

    for point, item in zip(points, items, strict=True):
        assert columns(result[point]) == recorded_columns(item)


def test_a_one_item_list_is_accepted_for_a_single_location(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=ok([recorded_denver()]))

    result = provider.fetch([DENVER], DENVER_WINDOW)

    assert columns(result[DENVER]) == recorded_columns(recorded_denver())


def test_the_provider_describes_itself_and_satisfies_the_weather_provider_protocol(
    upstream: UpstreamClient,
) -> None:
    provider: WeatherProvider = OpenMeteoProvider(upstream)
    assert (provider.name, provider.model) == ("open-meteo", "best_match")


# --------------------------------------------------------------------------- batch contract


def test_a_provider_announces_how_many_points_one_fetch_takes(upstream: UpstreamClient) -> None:
    assert OpenMeteoProvider(upstream).max_points == DEFAULT_CHUNK_SIZE
    assert OpenMeteoProvider(upstream, chunk_size=7).max_points == 7


# --------------------------------------------------------------------------- alignment


@pytest.mark.parametrize(
    ("offset_h", "hours"),
    [
        pytest.param(0, 49, id="exactly-the-recorded-span"),
        pytest.param(2, 10, id="later-start-and-shorter-extra-hours-ignored"),
        pytest.param(40, 9, id="the-tail-of-the-response"),
        pytest.param(-5, 54, id="starts-before-the-response"),
        pytest.param(0, 59, id="ends-after-the-response"),
        pytest.param(-3, 56, id="missing-on-both-sides"),
    ],
)
def test_forecast_hours_are_aligned_to_the_window_by_timestamp(
    router: respx.MockRouter, provider: OpenMeteoProvider, offset_h: int, hours: int
) -> None:
    recorded = recorded_denver()
    router.post(URL).mock(return_value=ok(recorded))
    window = HourWindow(DENVER_START + timedelta(hours=offset_h), hours)

    forecast = provider.fetch([DENVER], window)[DENVER]

    assert forecast.window == window
    expected = recorded_columns(recorded)
    for name, series in columns(forecast).items():
        assert len(series) == hours
        for position, value in enumerate(series):
            source = offset_h + position
            assert value == (expected[name][source] if 0 <= source < 49 else None)


def test_alignment_follows_timestamps_not_positions_when_the_response_has_a_gap(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    recorded = recorded_denver()
    without_hour_ten = [index for index in range(49) if index != 10]
    router.post(URL).mock(return_value=ok(select_hours(recorded, without_hour_ten)))

    forecast = provider.fetch([DENVER], DENVER_WINDOW)[DENVER]

    expected = recorded_columns(recorded)
    for name, series in columns(forecast).items():
        assert series[10] is None
        assert tuple(series[:10]) == expected[name][:10]
        assert tuple(series[11:]) == expected[name][11:]


def test_alignment_ignores_the_order_of_the_hours_in_the_response(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    recorded = recorded_denver()
    router.post(URL).mock(return_value=ok(select_hours(recorded, list(reversed(range(49))))))

    forecast = provider.fetch([DENVER], DENVER_WINDOW)[DENVER]

    assert columns(forecast) == recorded_columns(recorded)


@given(
    indexes=st.lists(st.integers(0, 48), unique=True, max_size=49),
    offset_h=st.integers(-12, 60),
    hours=st.integers(1, 70),
)
def test_every_window_hour_holds_the_recorded_value_of_its_timestamp_or_none(
    indexes: list[int], offset_h: int, hours: int
) -> None:
    recorded = recorded_denver()
    window = HourWindow(DENVER_START + timedelta(hours=offset_h), hours)
    with respx.MockRouter(assert_all_called=False) as router, build_client() as client:
        router.post(URL).mock(return_value=ok(select_hours(recorded, indexes)))
        upstream = UpstreamClient("open-meteo", client=client, pacing=Pacing(sleep=lambda _s: None))
        provider = OpenMeteoProvider(upstream)
        covered = any(
            0 <= offset_h + position < 49 and offset_h + position in indexes
            for position in range(hours)
        )
        if not covered:  # a time axis that misses the whole window is refused, not cached as gaps
            with pytest.raises(ProviderResponseError, match="no row for any requested hour"):
                provider.fetch([DENVER], window)
            return
        forecast = provider.fetch([DENVER], window)[DENVER]

    expected = recorded_columns(recorded)
    for name, series in columns(forecast).items():
        assert len(series) == hours
        for position, value in enumerate(series):
            source = offset_h + position
            present = 0 <= source < 49 and source in indexes
            assert value == (expected[name][source] if present else None)


def test_missing_values_stay_none_and_do_not_disturb_their_neighbours(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    recorded = recorded_denver()
    damaged = mutated(
        recorded,
        cell_set("wind_speed_10m", 3, None),
        cell_set("temperature_2m", 0, None),
        cell_set("weather_code", 48, None),
        hourly_set("snowfall", [None] * 49),
    )
    router.post(URL).mock(return_value=ok(damaged))

    forecast = provider.fetch([DENVER], DENVER_WINDOW)[DENVER]

    clean = recorded_columns(recorded)
    assert forecast.wind_speed_mph[3] is None
    assert forecast.wind_speed_mph[:3] == clean["wind_speed_10m"][:3]
    assert forecast.wind_speed_mph[4:] == clean["wind_speed_10m"][4:]
    assert forecast.temperature_f[0] is None
    assert forecast.temperature_f[1:] == clean["temperature_2m"][1:]
    assert forecast.weather_code[48] is None
    assert forecast.weather_code[:48] == clean["weather_code"][:48]
    assert forecast.snowfall_in == (None,) * 49


def test_a_response_whose_time_axis_misses_every_requested_hour_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    # R2-22: it used to become a forecast of nothing but None, cached for an hour.
    router.post(URL).mock(return_value=ok(recorded_denver()))
    window = HourWindow(DENVER_START + timedelta(hours=100), 5)

    with pytest.raises(ProviderResponseError, match="no row for any requested hour"):
        provider.fetch([DENVER], window)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        pytest.param("latitude", DENVER.lat + 0.51, id="north"),
        pytest.param("latitude", DENVER.lat - 0.51, id="south"),
        pytest.param("longitude", DENVER.lon + 0.51, id="east"),
        pytest.param("longitude", DENVER.lon - 0.51, id="west"),
    ],
)
def test_a_grid_cell_far_from_the_requested_point_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, key: str, value: float
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), item_set(key, value))))

    with pytest.raises(ProviderResponseError, match="grid cell is far from the requested point"):
        provider.fetch([DENVER], DENVER_WINDOW)


@pytest.mark.parametrize("offset", [0.0, 0.2, 0.49, -0.49])
def test_a_grid_cell_near_the_requested_point_is_accepted(
    router: respx.MockRouter, provider: OpenMeteoProvider, offset: float
) -> None:
    moved = mutated(
        recorded_denver(),
        item_set("latitude", DENVER.lat + offset),
        item_set("longitude", DENVER.lon - offset),
    )
    router.post(URL).mock(return_value=ok(moved))

    assert provider.fetch([DENVER], DENVER_WINDOW)[DENVER].hours == 49


def test_missing_grid_metadata_is_unknown_not_an_error(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    damaged = mutated(recorded_denver(), item_del("elevation"), item_set("latitude", None))
    router.post(URL).mock(return_value=ok(damaged))

    forecast = provider.fetch([DENVER], DENVER_WINDOW)[DENVER]

    assert (forecast.source_lat, forecast.elevation_m) == (None, None)
    assert forecast.source_lon == -104.987076


# --------------------------------------------------------------------------- units


def test_a_response_in_default_units_is_refused_not_silently_misread(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=httpx.Response(200, content=fixture_bytes(WRONG_UNITS_FILE)))
    window = HourWindow(datetime(2026, 10, 19, 21, tzinfo=UTC), 3)

    with pytest.raises(ProviderResponseError, match="unexpected units") as excinfo:
        provider.fetch([SALT_LAKE, DENVER, CHICAGO], window)

    assert excinfo.value.provider == "open-meteo"


@pytest.mark.parametrize("variable", VARIABLES)
def test_any_unit_label_other_than_the_expected_one_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, variable: str
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), units_set(variable, "?"))))

    with pytest.raises(ProviderResponseError, match=rf"unexpected units for {variable}$"):
        provider.fetch([DENVER], DENVER_WINDOW)


@pytest.mark.parametrize(
    ("variable", "label"),
    [
        ("wind_speed_10m", "mph"),
        ("wind_gusts_10m", "km/h"),
        ("snowfall", "cm"),
        ("precipitation", "mm"),
        ("temperature_2m", "\u00b0C"),
        ("time", "iso8601"),
    ],
)
def test_the_realistic_wrong_unit_labels_are_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, variable: str, label: str
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), units_set(variable, label))))

    with pytest.raises(ProviderResponseError, match=variable):
        provider.fetch([DENVER], DENVER_WINDOW)


def test_a_missing_unit_label_is_refused_and_named(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), units_del("snowfall"))))

    with pytest.raises(ProviderResponseError, match=r"unexpected units for snowfall$"):
        provider.fetch([DENVER], DENVER_WINDOW)


def test_an_additional_unit_label_means_the_api_changed_and_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), units_set("uv_index", "-"))))

    with pytest.raises(ProviderResponseError, match=r"unexpected units$"):
        provider.fetch([DENVER], DENVER_WINDOW)


@pytest.mark.parametrize(
    "mutation",
    [item_del("hourly_units"), item_set("hourly_units", None), item_set("hourly_units", ["mp/h"])],
    ids=["absent", "null", "list"],
)
def test_units_that_are_not_an_object_are_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, mutation: Mutation
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), mutation)))

    with pytest.raises(ProviderResponseError, match="unexpected units"):
        provider.fetch([DENVER], DENVER_WINDOW)


# --------------------------------------------------------------------------- values


INVALID_VALUES: dict[str, tuple[Mutation, str]] = {
    "nan": (cell_set("wind_speed_10m", 3, math.nan), "wind_speed_10m holds a non-finite value"),
    "infinity": (cell_set("rain", 0, math.inf), "rain holds a non-finite value"),
    "minus-infinity": (
        cell_set("temperature_2m", 48, -math.inf),
        "temperature_2m holds a non-finite value",
    ),
    "huge-integer": (cell_set("rain", 5, 10**400), "rain holds a non-finite value"),
    "string": (cell_set("wind_gusts_10m", 5, "12.5"), "wind_gusts_10m holds a non-numeric value"),
    "true": (cell_set("showers", 5, value=True), "showers holds a non-numeric value"),
    "false": (cell_set("snowfall", 5, value=False), "snowfall holds a non-numeric value"),
    "list": (cell_set("precipitation", 5, [1.0]), "precipitation holds a non-numeric value"),
    "object": (cell_set("rain", 5, {"v": 1}), "rain holds a non-numeric value"),
    "code-float": (cell_set("weather_code", 5, 3.5), "weather_code holds a non-integer value"),
    "code-whole-float": (
        cell_set("weather_code", 5, 3.0),
        "weather_code holds a non-integer value",
    ),
    "code-string": (cell_set("weather_code", 5, "3"), "weather_code holds a non-integer value"),
    "code-true": (
        cell_set("weather_code", 5, value=True),
        "weather_code holds a non-integer value",
    ),
    "code-nan": (cell_set("weather_code", 5, math.nan), "weather_code holds a non-integer value"),
    "latitude-string": (item_set("latitude", "39.7"), "latitude holds a non-numeric value"),
    "longitude-nan": (item_set("longitude", math.nan), "longitude holds a non-finite value"),
    "elevation-bool": (item_set("elevation", value=True), "elevation holds a non-numeric value"),
}


@pytest.mark.parametrize(
    ("mutation", "message"), list(INVALID_VALUES.values()), ids=list(INVALID_VALUES)
)
def test_values_that_are_not_finite_numbers_or_null_are_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, mutation: Mutation, message: str
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), mutation)))

    with pytest.raises(ProviderResponseError, match=message):
        provider.fetch([DENVER], DENVER_WINDOW)


def test_integers_are_accepted_wherever_numbers_are_expected(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), cell_set("rain", 2, 0))))

    forecast = provider.fetch([DENVER], DENVER_WINDOW)[DENVER]

    assert forecast.rain_in[2] == 0.0
    assert isinstance(forecast.rain_in[2], float)


# --------------------------------------------------------------------------- structure


@pytest.mark.parametrize(
    "payload", ["oops", 42, None, True], ids=["string", "number", "null", "true"]
)
def test_a_response_that_is_neither_an_object_nor_a_list_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, payload: object
) -> None:
    router.post(URL).mock(return_value=ok(payload))

    with pytest.raises(ProviderResponseError, match="neither an object nor a list"):
        provider.fetch([DENVER], DENVER_WINDOW)


@pytest.mark.parametrize(
    "entry", ["not an object", None, 7, ["x"]], ids=["str", "null", "int", "list"]
)
def test_a_location_entry_that_is_not_an_object_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, entry: object
) -> None:
    router.post(URL).mock(return_value=ok([entry]))

    with pytest.raises(ProviderResponseError, match="location entry is not an object"):
        provider.fetch([DENVER], DENVER_WINDOW)


MALFORMED_ITEMS: dict[str, tuple[Mutation, str]] = {
    "hourly-absent": (item_del("hourly"), "hourly is missing or not an object"),
    "hourly-null": (item_set("hourly", None), "hourly is missing or not an object"),
    "hourly-list": (item_set("hourly", [1, 2]), "hourly is missing or not an object"),
    "time-absent": (hourly_del("time"), "time is missing or not a list"),
    "time-string": (hourly_set("time", "2026-10-20"), "time is missing or not a list"),
    "time-iso8601": (hourly_set("time", ["2026-10-20T14:00"] * 49), "time holds a non-integer"),
    "time-float": (cell_set("time", 4, 1792504800.5), "time holds a non-integer"),
    "time-bool": (cell_set("time", 4, value=True), "time holds a non-integer"),
    "time-null": (cell_set("time", 4, None), "time holds a non-integer"),
    "time-duplicate": (cell_set("time", 4, 1792504800), "time repeats a timestamp"),
    "variable-absent": (hourly_del("rain"), "rain is missing or not a list"),
    "variable-string": (hourly_set("rain", "0"), "rain is missing or not a list"),
    "variable-null": (hourly_set("weather_code", None), "weather_code is missing or not a list"),
    "variable-short": (hourly_set("snowfall", [0.0] * 48), "snowfall has 48 values for 49"),
    "variable-long": (hourly_set("snowfall", [0.0] * 50), "snowfall has 50 values for 49"),
}


@pytest.mark.parametrize(
    ("mutation", "message"), list(MALFORMED_ITEMS.values()), ids=list(MALFORMED_ITEMS)
)
def test_a_location_entry_that_is_not_the_documented_shape_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, mutation: Mutation, message: str
) -> None:
    router.post(URL).mock(return_value=ok(mutated(recorded_denver(), mutation)))

    with pytest.raises(ProviderResponseError, match=message):
        provider.fetch([DENVER], DENVER_WINDOW)


@pytest.mark.parametrize("answered", [0, 1, 2, 4])
def test_a_wrong_number_of_locations_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider, answered: int
) -> None:
    items = [recorded_denver() for _ in range(answered)]
    router.post(URL).mock(return_value=ok(items[0] if answered == 1 else items))

    with pytest.raises(ProviderResponseError, match=f"expected 3 locations, got {answered}"):
        provider.fetch([SALT_LAKE, DENVER, CHICAGO], DENVER_WINDOW)


# --------------------------------------------------------------------------- upstream failures


REJECTIONS = [
    "openmeteo-error-bad-latitude.json",
    "openmeteo-error-bad-unit.json",
    "openmeteo-error-bad-variable.json",
    "openmeteo-error-count-mismatch.json",
    "openmeteo-error-forecast-days-17.json",
    "openmeteo-1001loc-post-retry.json",
]


@pytest.mark.parametrize("name", REJECTIONS)
def test_the_recorded_http_400_bodies_surface_as_rejections_with_the_reason(
    router: respx.MockRouter, provider: OpenMeteoProvider, name: str
) -> None:
    router.post(URL).mock(return_value=httpx.Response(400, content=fixture_bytes(name)))
    reason = obj(fixture(name))["reason"]
    assert isinstance(reason, str)

    with pytest.raises(ProviderRejectedError) as excinfo:
        provider.fetch([DENVER], DENVER_WINDOW)

    assert excinfo.value.status == 400
    assert excinfo.value.provider == "open-meteo"
    assert reason[:50] in excinfo.value.message


def test_a_200_with_an_empty_body_is_an_upstream_failure(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    body = fixture_bytes("openmeteo-error-no-coords.txt")
    assert body == b""
    router.post(URL).mock(return_value=httpx.Response(200, content=body))

    with pytest.raises(ProviderResponseError, match="not valid JSON"):
        provider.fetch([DENVER], DENVER_WINDOW)


def test_a_429_with_a_short_retry_after_is_retried_once_after_that_wait(
    router: respx.MockRouter, provider: OpenMeteoProvider, sleeps: list[float]
) -> None:
    limited = httpx.Response(
        429, headers={"Retry-After": "2"}, content=fixture_bytes("openmeteo-1001loc-post.json")
    )
    route = router.post(URL).mock(side_effect=[limited, ok(recorded_denver())])

    result = provider.fetch([DENVER], DENVER_WINDOW)

    assert columns(result[DENVER]) == recorded_columns(recorded_denver())
    assert route.call_count == 2
    assert sleeps == [2.0]


def test_a_429_asking_for_longer_than_the_budget_surfaces_with_its_hint(
    router: respx.MockRouter, provider: OpenMeteoProvider, sleeps: list[float]
) -> None:
    limited = httpx.Response(
        429, headers={"Retry-After": "30"}, content=fixture_bytes("openmeteo-1001loc-post.json")
    )
    route = router.post(URL).mock(return_value=limited)

    with pytest.raises(ProviderRateLimitedError) as excinfo:
        provider.fetch([DENVER], DENVER_WINDOW)

    assert excinfo.value.retry_after_s == 30.0
    assert route.call_count == 1
    assert sleeps == []


def test_a_429_that_persists_is_surfaced_after_the_single_retry(
    router: respx.MockRouter, provider: OpenMeteoProvider, sleeps: list[float]
) -> None:
    route = router.post(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "1"}),
            httpx.Response(429, headers={"Retry-After": "1"}),
            ok(recorded_denver()),
        ]
    )

    with pytest.raises(ProviderRateLimitedError, match="rate limited") as excinfo:
        provider.fetch([DENVER], DENVER_WINDOW)

    assert excinfo.value.retry_after_s == 1.0
    assert route.call_count == 2
    assert sleeps == [1.0]
    assert isinstance(excinfo.value, ProviderUnavailableError)


def test_a_429_without_a_hint_is_surfaced_at_once(
    router: respx.MockRouter, provider: OpenMeteoProvider, sleeps: list[float]
) -> None:
    # Open-Meteo's own 429 says to try again in a minute and sends no Retry-After: asking again
    # straight away would only spend more of the allowance on a certain refusal.
    route = router.post(URL).mock(side_effect=[httpx.Response(429), ok(recorded_denver())])

    with pytest.raises(ProviderRateLimitedError) as excinfo:
        provider.fetch([DENVER], DENVER_WINDOW)

    assert excinfo.value.retry_after_s is None
    assert route.call_count == 1
    assert sleeps == []


def test_a_5xx_is_retried_twice_then_reported_as_unavailable(
    router: respx.MockRouter, provider: OpenMeteoProvider, sleeps: list[float]
) -> None:
    route = router.post(URL).mock(side_effect=[httpx.Response(503) for _ in range(3)])

    with pytest.raises(ProviderUnavailableError, match="HTTP 503"):
        provider.fetch([DENVER], DENVER_WINDOW)

    assert route.call_count == 3
    assert sleeps == [0.0, 0.0]


def test_a_5xx_that_clears_up_is_invisible_to_the_caller(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(side_effect=[httpx.Response(502), ok(recorded_denver())])

    result = provider.fetch([DENVER], DENVER_WINDOW)

    assert columns(result[DENVER]) == recorded_columns(recorded_denver())


def test_a_timeout_is_reported_as_unavailable_after_the_retries(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    route = router.post(URL).mock(side_effect=httpx.ReadTimeout("slow"))

    with pytest.raises(ProviderUnavailableError, match="timed out"):
        provider.fetch([DENVER], DENVER_WINDOW)

    assert route.call_count == 3


def test_a_connection_failure_is_reported_as_unavailable(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(ProviderUnavailableError, match="connection failed"):
        provider.fetch([DENVER], DENVER_WINDOW)


# --------------------------------------------------------------------------- snow (real values)


SNOW_SITES = [
    (64.84, -147.72),
    (61.22, -149.9),
    (46.54, -87.4),
    (44.27, -71.3),
    (39.66, -105.88),
    (40.59, -111.64),
    (48.41, -114.34),
    (43.48, -110.76),
    (48.6, -93.4),
    (42.89, -78.88),
    (46.86, -68.01),
    (39.25, -106.29),
]
SNOW_POINTS = [snap_to_lattice(lat, lon) for lat, lon in SNOW_SITES]
SNOW_WINDOW = HourWindow(datetime(2026, 10, 19, tzinfo=UTC), 72)


def rewrap_snow_site(site: JsonObject) -> JsonObject:
    """Re-wrap a real snow-site record into the shape our request returns.

    The snow probe asked for five variables with default degrees Celsius and ISO 8601 times.
    The real snowfall, precipitation, rain and shower numbers (inches) are kept untouched, the
    time axis becomes unixtime, temperature is converted to Fahrenheit and the three variables
    the probe did not request (wind, gusts, weather code) are filled with constants.
    """
    hourly = obj(site["hourly"])
    stamps = [str(stamp) for stamp in arr(hourly["time"])]
    celsius = [value for value in numbers(hourly["temperature_2m"]) if value is not None]
    return {
        "latitude": site["latitude"],
        "longitude": site["longitude"],
        "elevation": site["elevation"],
        "hourly_units": dict(RECORDED_UNITS),
        "hourly": {
            "time": [
                int(datetime.fromisoformat(stamp).replace(tzinfo=UTC).timestamp())
                for stamp in stamps
            ],
            "wind_speed_10m": [0.0] * len(stamps),
            "wind_gusts_10m": [0.0] * len(stamps),
            "rain": hourly["rain"],
            "showers": hourly["showers"],
            "snowfall": hourly["snowfall"],
            "precipitation": hourly["precipitation"],
            "temperature_2m": [value * 9 / 5 + 32 for value in celsius],
            "weather_code": [0] * len(stamps),
        },
    }


def test_the_snow_probe_as_recorded_is_not_our_request_shape_and_is_refused(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    router.post(URL).mock(return_value=httpx.Response(200, content=fixture_bytes(SNOW_FILE)))

    with pytest.raises(ProviderResponseError, match="unexpected units"):
        provider.fetch(SNOW_POINTS, SNOW_WINDOW)


def test_real_snowfall_in_inches_passes_through_without_any_conversion(
    router: respx.MockRouter, provider: OpenMeteoProvider
) -> None:
    sites = recorded_list(SNOW_FILE)
    router.post(URL).mock(return_value=ok([rewrap_snow_site(site) for site in sites]))

    result = provider.fetch(SNOW_POINTS, SNOW_WINDOW)

    snowy_hours = 0
    for point, site in zip(SNOW_POINTS, sites, strict=True):
        hourly = obj(site["hourly"])
        forecast = result[point]
        assert forecast.snowfall_in == numbers(hourly["snowfall"])
        assert forecast.precipitation_in == numbers(hourly["precipitation"])
        assert forecast.rain_in == numbers(hourly["rain"])
        assert forecast.showers_in == numbers(hourly["showers"])
        snowy_hours += sum(1 for value in forecast.snowfall_in if value)
    assert snowy_hours > 40  # the recorded window really contains snow


# --------------------------------------------------------------------------- hash and credit


EXPECTED_VARIABLE_SET_HASH = "e96c9ab2bd2b68cd"


def test_the_variable_set_hash_is_sixteen_lowercase_hex_digits() -> None:
    assert re.fullmatch(r"[0-9a-f]{16}", VARIABLE_SET_HASH)


def test_the_variable_set_hash_is_the_sha256_of_the_variables_and_unit_parameters() -> None:
    text = "|".join(VARIABLES) + "|" + "|".join(f"{key}={value}" for key, value in UNIT_PARAMETERS)
    assert hashlib.sha256(text.encode("utf-8")).hexdigest()[:16] == VARIABLE_SET_HASH
    assert variable_set_hash(VARIABLES, UNIT_PARAMETERS) == VARIABLE_SET_HASH


def test_the_variable_set_hash_is_pinned_so_cache_keys_only_change_on_purpose() -> None:
    assert VARIABLE_SET_HASH == EXPECTED_VARIABLE_SET_HASH


def test_the_unit_parameters_are_the_ones_the_request_sends() -> None:
    assert UNIT_PARAMETERS == (
        ("wind_speed_unit", "mph"),
        ("precipitation_unit", "inch"),
        ("temperature_unit", "fahrenheit"),
    )


@pytest.mark.parametrize(
    "variables",
    [
        VARIABLES[:-1],
        VARIABLES[::-1],
        (*VARIABLES, "uv_index"),
        ("windspeed_10m", *VARIABLES[1:]),
    ],
    ids=["one-removed", "reordered", "one-added", "one-renamed"],
)
def test_changing_a_variable_changes_the_hash(variables: tuple[str, ...]) -> None:
    assert variable_set_hash(variables, UNIT_PARAMETERS) != VARIABLE_SET_HASH


@pytest.mark.parametrize(
    "units",
    [
        (("wind_speed_unit", "kmh"), *UNIT_PARAMETERS[1:]),
        (UNIT_PARAMETERS[0], ("precipitation_unit", "mm"), UNIT_PARAMETERS[2]),
        (*UNIT_PARAMETERS[:2], ("temperature_unit", "celsius")),
        UNIT_PARAMETERS[:2],
        (*UNIT_PARAMETERS, ("cell_selection", "land")),
    ],
    ids=["wind", "precipitation", "temperature", "one-removed", "one-added"],
)
def test_changing_a_unit_changes_the_hash(units: tuple[tuple[str, str], ...]) -> None:
    assert variable_set_hash(VARIABLES, units) != VARIABLE_SET_HASH


def test_the_attribution_is_the_exact_text_the_licence_asks_for() -> None:
    assert OPENMETEO_ATTRIBUTION == "Weather data by Open-Meteo.com (CC BY 4.0)"
