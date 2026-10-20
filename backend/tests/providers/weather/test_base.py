"""Tests of the provider-neutral weather types in ``haulcast.providers.weather.base``."""

import json
import math
from datetime import UTC, datetime, timedelta, timezone

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.weather.base import (
    MAX_WINDOW_HOURS,
    PAYLOAD_VERSION,
    VARIABLES,
    ForecastPayloadError,
    HourlyForecast,
    HourWindow,
    LatticeError,
    LatticePoint,
    ceil_hour,
    floor_hour,
    snap_to_lattice,
)

START = datetime(2026, 10, 20, 14, tzinfo=UTC)
NAIVE_START = START.replace(tzinfo=None)
POINT = LatticePoint(397, -1050)
MODEL = "best_match"
PLUS_FIVE = timezone(timedelta(hours=5))


# --------------------------------------------------------------------------- lattice


def test_snap_to_lattice_maps_denver_onto_its_tenth_degree_point() -> None:
    assert snap_to_lattice(39.7392, -104.9903) == LatticePoint(397, -1050)


@pytest.mark.parametrize(
    ("value", "expected_e1"),
    [
        (0.05, 1),
        (0.15, 2),
        (0.25, 3),
        (-0.05, 0),
        (-0.15, -1),
        (-0.25, -2),
        (0.049, 0),
        (-0.051, -1),
    ],
)
def test_snap_to_lattice_rounds_to_nearest_and_breaks_ties_upwards(
    value: float, expected_e1: int
) -> None:
    assert snap_to_lattice(value, value) == LatticePoint(expected_e1, expected_e1)


@pytest.mark.parametrize(
    ("lat", "lon", "expected"),
    [
        (90.0, 180.0, LatticePoint(900, 1800)),
        (-90.0, -180.0, LatticePoint(-900, -1800)),
        (0.0, 0.0, LatticePoint(0, 0)),
    ],
)
def test_snap_to_lattice_accepts_the_extreme_coordinates(
    lat: float, lon: float, expected: LatticePoint
) -> None:
    assert snap_to_lattice(lat, lon) == expected


@pytest.mark.parametrize(
    ("lat", "lon"),
    [(91.0, 0.0), (-91.0, 0.0), (0.0, 181.0), (0.0, -181.0), (90.06, 0.0), (0.0, 180.06)],
)
def test_snap_to_lattice_rejects_out_of_range_coordinates(lat: float, lon: float) -> None:
    with pytest.raises(LatticeError, match="outside the valid"):
        snap_to_lattice(lat, lon)


@pytest.mark.parametrize(
    ("lat", "lon"),
    [(math.nan, 0.0), (0.0, math.nan), (math.inf, 0.0), (0.0, -math.inf)],
)
def test_snap_to_lattice_rejects_non_finite_coordinates(lat: float, lon: float) -> None:
    with pytest.raises(LatticeError, match="finite"):
        snap_to_lattice(lat, lon)


@given(
    lat=st.floats(min_value=-90.0, max_value=90.0),
    lon=st.floats(min_value=-180.0, max_value=180.0),
)
def test_snapping_never_moves_a_point_by_more_than_half_a_step(lat: float, lon: float) -> None:
    point = snap_to_lattice(lat, lon)
    assert abs(point.lat - lat) <= 0.05 + 1e-9
    assert abs(point.lon - lon) <= 0.05 + 1e-9


@given(lat_e1=st.integers(-900, 900), lon_e1=st.integers(-1800, 1800))
def test_lattice_points_are_fixed_points_of_snapping(lat_e1: int, lon_e1: int) -> None:
    point = LatticePoint(lat_e1, lon_e1)
    assert snap_to_lattice(point.lat, point.lon) == point


def test_lattice_point_exposes_degrees_and_a_signed_cache_key() -> None:
    point = LatticePoint(397, -1050)
    assert (point.lat, point.lon) == (39.7, -105.0)
    assert point.key == "+397,-1050"
    assert LatticePoint(0, 0).key == "+0,+0"
    assert LatticePoint(-5, 5).key == "-5,+5"


def test_lattice_points_order_by_latitude_then_longitude() -> None:
    points = [LatticePoint(2, 1), LatticePoint(1, 9), LatticePoint(1, -9)]
    assert sorted(points) == [LatticePoint(1, -9), LatticePoint(1, 9), LatticePoint(2, 1)]


@given(a=st.integers(-900, 900), b=st.integers(-1800, 1800), c=st.integers(-900, 900))
def test_lattice_point_keys_identify_points(a: int, b: int, c: int) -> None:
    first, second = LatticePoint(a, b), LatticePoint(c, b)
    assert (first.key == second.key) is (first == second)


# --------------------------------------------------------------------------- hours


def test_floor_and_ceil_hour_convert_to_utc_first() -> None:
    moment = datetime(2026, 10, 20, 10, 30, 15, 5, tzinfo=PLUS_FIVE)  # 05:30:15.000005 UTC
    assert floor_hour(moment) == datetime(2026, 10, 20, 5, tzinfo=UTC)
    assert ceil_hour(moment) == datetime(2026, 10, 20, 6, tzinfo=UTC)


def test_ceil_hour_keeps_an_instant_that_is_already_on_the_hour() -> None:
    on_the_hour = datetime(2026, 10, 20, 10, tzinfo=PLUS_FIVE)
    expected = datetime(2026, 10, 20, 5, tzinfo=UTC)
    assert floor_hour(on_the_hour) == ceil_hour(on_the_hour) == expected


def test_ceil_hour_rolls_over_midnight() -> None:
    moment = datetime(2026, 10, 20, 23, 1, tzinfo=UTC)
    assert ceil_hour(moment) == datetime(2026, 10, 21, 0, tzinfo=UTC)


def test_window_end_is_the_last_inclusive_stamp() -> None:
    assert HourWindow(START, 49).end == START + timedelta(hours=48)
    assert HourWindow(START, 1).end == START


@pytest.mark.parametrize(
    ("start", "message"),
    [
        (NAIVE_START, "timezone-aware UTC"),
        (datetime(2026, 10, 20, 14, tzinfo=PLUS_FIVE), "timezone-aware UTC"),
        (START.replace(minute=30), "on the hour"),
        (START.replace(second=1), "on the hour"),
        (START.replace(microsecond=1), "on the hour"),
    ],
)
def test_window_rejects_a_start_that_is_not_a_utc_hour(start: datetime, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        HourWindow(start, 3)


@pytest.mark.parametrize("hours", [0, -1, MAX_WINDOW_HOURS + 1])
def test_window_rejects_a_length_outside_one_to_sixteen_days(hours: int) -> None:
    with pytest.raises(ValueError, match="window must span"):
        HourWindow(START, hours)


def test_window_accepts_the_longest_allowed_length() -> None:
    assert HourWindow(START, MAX_WINDOW_HOURS).hours == 384


def test_covering_rounds_outwards_to_whole_hours() -> None:
    first = datetime(2026, 10, 20, 10, 20, tzinfo=UTC)
    last = datetime(2026, 10, 20, 13, 40, tzinfo=UTC)
    assert HourWindow.covering(first, last) == HourWindow(datetime(2026, 10, 20, 10, tzinfo=UTC), 5)


def test_covering_one_instant_on_the_hour_is_a_single_hour() -> None:
    assert HourWindow.covering(START, START) == HourWindow(START, 1)


def test_covering_accepts_other_time_zones() -> None:
    first = datetime(2026, 10, 20, 19, 30, tzinfo=PLUS_FIVE)  # 14:30 UTC
    last = datetime(2026, 10, 20, 21, 0, tzinfo=PLUS_FIVE)  # 16:00 UTC
    assert HourWindow.covering(first, last) == HourWindow(START, 3)


def test_covering_more_than_sixteen_days_is_refused() -> None:
    with pytest.raises(ValueError, match="window must span"):
        HourWindow.covering(START, START + timedelta(days=20))


@given(offset_s=st.integers(0, 3 * 24 * 3600), length_s=st.integers(0, 5 * 24 * 3600))
def test_covering_contains_both_instants_and_is_minimal(offset_s: int, length_s: int) -> None:
    first = START + timedelta(seconds=offset_s)
    last = first + timedelta(seconds=length_s)
    window = HourWindow.covering(first, last)
    assert window.start <= first < window.start + timedelta(hours=1)
    assert window.end - timedelta(hours=1) < last <= window.end


def test_window_covers_only_windows_inside_it() -> None:
    outer = HourWindow(START, 10)
    assert outer.covers(outer)
    assert outer.covers(HourWindow(START + timedelta(hours=3), 4))
    assert not outer.covers(HourWindow(START - timedelta(hours=1), 3))
    assert not outer.covers(HourWindow(START + timedelta(hours=8), 3))
    assert not HourWindow(START + timedelta(hours=3), 4).covers(outer)


# --------------------------------------------------------------------------- forecasts


def make_forecast(*, hours: int = 3, start: datetime = START) -> HourlyForecast:
    """Return a forecast with a null temperature, a null weather code and some snow."""
    wind = tuple(float(i) for i in range(hours))
    return HourlyForecast(
        point=POINT,
        model=MODEL,
        start=start,
        wind_speed_mph=wind,
        wind_gust_mph=tuple(value + 5.0 for value in wind),
        rain_in=(0.0,) * hours,
        showers_in=(0.0,) * hours,
        snowfall_in=tuple(0.5 if i == 1 else 0.0 for i in range(hours)),
        precipitation_in=tuple(0.07 if i == 1 else 0.0 for i in range(hours)),
        temperature_f=(None, *([30.5] * (hours - 1))),
        weather_code=(3, None, *([75] * (hours - 2))),
        source_lat=39.746895,
        source_lon=-104.987076,
        elevation_m=1599.0,
    )


def test_forecast_reports_its_length_and_window() -> None:
    forecast = make_forecast(hours=3)
    assert forecast.hours == 3
    assert forecast.window == HourWindow(START, 3)


def test_forecast_source_defaults_to_unknown() -> None:
    bare = HourlyForecast(
        point=POINT,
        model=MODEL,
        start=START,
        wind_speed_mph=(1.0,),
        wind_gust_mph=(2.0,),
        rain_in=(0.0,),
        showers_in=(0.0,),
        snowfall_in=(0.0,),
        precipitation_in=(0.0,),
        temperature_f=(50.0,),
        weather_code=(0,),
    )
    assert (bare.source_lat, bare.source_lon, bare.elevation_m) == (None, None, None)


@pytest.mark.parametrize(
    "start",
    [NAIVE_START, START.replace(minute=30), START.replace(second=1)],
    ids=["naive", "half-past", "one-second"],
)
def test_forecast_requires_a_timezone_aware_utc_hour_start(start: datetime) -> None:
    with pytest.raises(ValueError, match="timezone-aware UTC hour"):
        make_forecast(start=start)


def test_forecast_requires_equal_length_arrays() -> None:
    good = make_forecast(hours=3)
    with pytest.raises(ValueError, match="one non-zero length"):
        HourlyForecast(
            point=good.point,
            model=good.model,
            start=good.start,
            wind_speed_mph=good.wind_speed_mph[:2],
            wind_gust_mph=good.wind_gust_mph,
            rain_in=good.rain_in,
            showers_in=good.showers_in,
            snowfall_in=good.snowfall_in,
            precipitation_in=good.precipitation_in,
            temperature_f=good.temperature_f,
            weather_code=good.weather_code,
        )


def test_forecast_requires_at_least_one_hour() -> None:
    with pytest.raises(ValueError, match="one non-zero length"):
        HourlyForecast(
            point=POINT,
            model=MODEL,
            start=START,
            wind_speed_mph=(),
            wind_gust_mph=(),
            rain_in=(),
            showers_in=(),
            snowfall_in=(),
            precipitation_in=(),
            temperature_f=(),
            weather_code=(),
        )


def test_variables_are_the_eight_open_meteo_hourly_names_in_contract_order() -> None:
    assert VARIABLES == (
        "wind_speed_10m",
        "wind_gusts_10m",
        "rain",
        "showers",
        "snowfall",
        "precipitation",
        "temperature_2m",
        "weather_code",
    )


# --------------------------------------------------------------------------- payload


def test_payload_uses_open_meteo_names_and_json_types() -> None:
    payload = make_forecast(hours=3).to_payload()
    assert payload == {
        "v": PAYLOAD_VERSION,
        "start": int(START.timestamp()),
        "hours": 3,
        "source": {"lat": 39.746895, "lon": -104.987076, "elevation_m": 1599.0},
        "series": {
            "wind_speed_10m": [0.0, 1.0, 2.0],
            "wind_gusts_10m": [5.0, 6.0, 7.0],
            "rain": [0.0, 0.0, 0.0],
            "showers": [0.0, 0.0, 0.0],
            "snowfall": [0.0, 0.5, 0.0],
            "precipitation": [0.0, 0.07, 0.0],
            "temperature_2m": [None, 30.5, 30.5],
            "weather_code": [3, None, 75],
        },
    }
    assert json.loads(json.dumps(payload)) == payload


def test_payload_round_trips_through_json_text() -> None:
    forecast = make_forecast(hours=5)
    stored = json.loads(json.dumps(forecast.to_payload()))
    assert HourlyForecast.from_payload(POINT, MODEL, stored) == forecast


def test_payload_round_trip_keeps_the_point_and_model_of_the_caller() -> None:
    other_point = LatticePoint(408, -1119)
    rebuilt = HourlyForecast.from_payload(other_point, "gfs", make_forecast().to_payload())
    assert (rebuilt.point, rebuilt.model) == (other_point, "gfs")


def test_payload_round_trip_keeps_unknown_source_cells() -> None:
    forecast = make_forecast()
    blank = HourlyForecast(
        point=forecast.point,
        model=forecast.model,
        start=forecast.start,
        wind_speed_mph=forecast.wind_speed_mph,
        wind_gust_mph=forecast.wind_gust_mph,
        rain_in=forecast.rain_in,
        showers_in=forecast.showers_in,
        snowfall_in=forecast.snowfall_in,
        precipitation_in=forecast.precipitation_in,
        temperature_f=forecast.temperature_f,
        weather_code=forecast.weather_code,
    )
    assert HourlyForecast.from_payload(POINT, MODEL, blank.to_payload()) == blank


finite_floats = st.floats(allow_nan=False, allow_infinity=False)
optional_floats = st.one_of(st.none(), finite_floats)
naive_epoch = datetime(2000, 1, 1, tzinfo=UTC).replace(tzinfo=None)
naive_horizon = datetime(2100, 1, 1, tzinfo=UTC).replace(tzinfo=None)


@st.composite
def forecasts(draw: st.DrawFn) -> HourlyForecast:
    hours = draw(st.integers(1, 8))
    start = draw(
        st.datetimes(min_value=naive_epoch, max_value=naive_horizon, timezones=st.just(UTC))
    )
    series = st.lists(optional_floats, min_size=hours, max_size=hours).map(tuple)
    codes = st.lists(st.one_of(st.none(), st.integers(0, 99)), min_size=hours, max_size=hours)
    return HourlyForecast(
        point=draw(st.builds(LatticePoint, st.integers(-900, 900), st.integers(-1800, 1800))),
        model=draw(st.sampled_from(["best_match", "scenario:calm"])),
        start=floor_hour(start),
        wind_speed_mph=draw(series),
        wind_gust_mph=draw(series),
        rain_in=draw(series),
        showers_in=draw(series),
        snowfall_in=draw(series),
        precipitation_in=draw(series),
        temperature_f=draw(series),
        weather_code=tuple(draw(codes)),
        source_lat=draw(optional_floats),
        source_lon=draw(optional_floats),
        elevation_m=draw(optional_floats),
    )


@given(forecast=forecasts())
def test_every_forecast_survives_a_json_round_trip(forecast: HourlyForecast) -> None:
    stored = json.loads(json.dumps(forecast.to_payload()))
    assert HourlyForecast.from_payload(forecast.point, forecast.model, stored) == forecast


def fresh_payload() -> dict[str, object]:
    return make_forecast(hours=3).to_payload()


def child(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload[key]
    assert isinstance(value, dict)
    return value


def with_top(**changes: object) -> dict[str, object]:
    payload = fresh_payload()
    payload.update(changes)
    return payload


def with_series(**changes: object) -> dict[str, object]:
    payload = fresh_payload()
    child(payload, "series").update(changes)
    return payload


def with_source(**changes: object) -> dict[str, object]:
    payload = fresh_payload()
    child(payload, "source").update(changes)
    return payload


def without_top(key: str) -> dict[str, object]:
    payload = fresh_payload()
    del payload[key]
    return payload


def without_series(key: str) -> dict[str, object]:
    payload = fresh_payload()
    del child(payload, "series")[key]
    return payload


def without_source(key: str) -> dict[str, object]:
    payload = fresh_payload()
    del child(payload, "source")[key]
    return payload


def test_payload_accepts_whole_numbers_as_floats() -> None:
    rebuilt = HourlyForecast.from_payload(POINT, MODEL, with_series(wind_speed_10m=[1, 2, 3]))
    assert rebuilt.wind_speed_mph == (1.0, 2.0, 3.0)
    assert all(isinstance(value, float) for value in rebuilt.wind_speed_mph)


START_S = int(START.timestamp())
MALFORMED: dict[str, object] = {
    "not-a-document": ["v", 1],
    "none": None,
    "no-version": without_top("v"),
    "other-version": with_top(v=PAYLOAD_VERSION + 1),
    "no-series": without_top("series"),
    "no-source": without_top("source"),
    "no-hours": without_top("hours"),
    "no-start": without_top("start"),
    "series-not-a-dict": with_top(series=[1, 2, 3]),
    "source-not-a-dict": with_top(source="here"),
    "hours-not-an-int": with_top(hours=3.0),
    "missing-variable": without_series("rain"),
    "series-too-short": with_series(rain=[0.0, 0.0]),
    "series-not-a-list": with_series(rain="0.0,0.0,0.0"),
    "code-series-too-short": with_series(weather_code=[3, 3]),
    "code-series-not-a-list": with_series(weather_code=(3, 3, 3)),
    "string-number": with_series(rain=[0.0, "0.1", 0.0]),
    "bool-number": with_series(rain=[0.0, True, 0.0]),
    "float-code": with_series(weather_code=[3, 3.5, 3]),
    "bool-code": with_series(weather_code=[3, True, 3]),
    "string-code": with_series(weather_code=[3, "3", 3]),
    "start-not-an-int": with_top(start=float(START_S)),
    "start-a-bool": with_top(start=True),
    "start-off-the-hour": with_top(start=START_S + 60),
    "start-out-of-range": with_top(start=10**30),
    "source-string": with_source(lat="39.7"),
    "source-bool": with_source(elevation_m=False),
    "source-missing-key": without_source("lon"),
    "zero-hours": with_top(hours=0, series={name: [] for name in VARIABLES}),
}


@pytest.mark.parametrize("payload", list(MALFORMED.values()), ids=list(MALFORMED))
def test_malformed_payloads_are_rejected_as_cache_misses(payload: object) -> None:
    with pytest.raises(ForecastPayloadError, match="malformed"):
        HourlyForecast.from_payload(POINT, MODEL, payload)


def test_payload_errors_are_value_errors_that_keep_their_cause() -> None:
    with pytest.raises(ForecastPayloadError) as excinfo:
        HourlyForecast.from_payload(POINT, MODEL, {"v": 99})
    assert isinstance(excinfo.value, ValueError)
    assert excinfo.value.__cause__ is not None


def test_lattice_error_is_a_value_error() -> None:
    assert issubclass(LatticeError, ValueError)
