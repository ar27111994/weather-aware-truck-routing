"""Tests of the scenario weather evaluator: hand-computed values and the shipped scenarios."""

import json
import math
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.config.paths import shared_dir
from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.diversity import DiversityPolicy
from haulcast.providers.routing.geometry import haversine_mi
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
from haulcast.providers.weather.scenario import (
    CODE_THRESHOLD,
    ScenarioAnchor,
    ScenarioWeatherProvider,
    displaced,
    spatial_intensity,
    temporal_intensity,
)
from haulcast.providers.weather.scenarios import (
    ActiveWindow,
    Conditions,
    Motion,
    Scenario,
    ScenarioCatalog,
    StormCell,
)
from tests.providers.routing import test_valhalla
from tests.providers.routing.support import FakeClock

DEPARTURE = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
CENTRE = LatticePoint(410, -1000)  # 41.0 N, 100.0 W: the middle of the test route

BASELINE = Conditions(
    wind_mph=10.0,
    gust_mph=16.0,
    rain_in_hr=0.0,
    snow_in_hr=0.0,
    temperature_f=50.0,
    weather_code=1,
)
PEAK = Conditions(
    wind_mph=40.0,
    gust_mph=56.0,
    rain_in_hr=0.4,
    snow_in_hr=2.0,
    temperature_f=20.0,
    weather_code=75,
)
WINDOW = ActiveWindow(start_offset_h=-1.5, end_offset_h=3.0, ramp_h=1.0)


def two_hour_route() -> ScenarioAnchor:
    """40 N to 42 N along 100 W in exactly two hours: the middle (41 N) is reached at 13:00Z."""
    coords: tuple[Coordinate, ...] = ((-100.0, 40.0), (-100.0, 41.0), (-100.0, 42.0))
    leg = haversine_mi(coords[0], coords[1])
    return ScenarioAnchor(coords, (0.0, leg, 2 * leg), (0.0, 3600.0, 7200.0), DEPARTURE)


def cell(
    cell_id: str = "front",
    *,
    place: tuple[float, float, float] = (0.5, 20.0, 0.5),
    window: ActiveWindow = WINDOW,
    peak: Conditions = PEAK,
    motion: Motion | None = None,
) -> StormCell:
    """A cell at ``place`` = (fraction along the route, radius in miles, core fraction)."""
    fraction, radius_mi, core_fraction = place
    return StormCell(
        id=cell_id,
        fraction=fraction,
        radius_mi=radius_mi,
        core_fraction=core_fraction,
        window=window,
        peak=peak,
        motion=motion,
    )


def scenario_of(*cells: StormCell, baseline: Conditions = BASELINE) -> Scenario:
    return Scenario(
        id="test",
        name="Test scenario",
        description="A scenario for tests.",
        sort_order=1,
        baseline=baseline,
        cells=cells,
    )


def provider_of(*cells: StormCell, baseline: Conditions = BASELINE) -> ScenarioWeatherProvider:
    return ScenarioWeatherProvider(scenario_of(*cells, baseline=baseline), two_hour_route())


EIGHT_HOURS = HourWindow(datetime(2026, 10, 20, 10, tzinfo=UTC), 8)  # 10:00Z .. 17:00Z


def forecast_at(
    provider: ScenarioWeatherProvider, point: LatticePoint, window: HourWindow = EIGHT_HOURS
) -> HourlyForecast:
    return provider.fetch([point], window)[point]


# --------------------------------------------------------------------------- the anchor


def test_the_anchor_locates_positions_and_times_by_interpolating_the_route() -> None:
    anchor = two_hour_route()

    start, start_s = anchor.position_at(0.0)
    middle, middle_s = anchor.position_at(anchor.cum_mi[1])
    quarter, quarter_s = anchor.position_at(anchor.cum_mi[1] / 2)
    end, end_s = anchor.position_at(anchor.cum_mi[2])

    assert (start, start_s) == ((-100.0, 40.0), 0.0)
    assert middle == pytest.approx((-100.0, 41.0))
    assert middle_s == pytest.approx(3600.0)
    assert quarter == pytest.approx((-100.0, 40.5))
    assert quarter_s == pytest.approx(1800.0)
    assert end == pytest.approx((-100.0, 42.0))
    assert end_s == pytest.approx(7200.0)


def test_positions_beyond_the_route_are_clamped_to_its_ends() -> None:
    anchor = two_hour_route()

    assert anchor.position_at(-5.0) == ((-100.0, 40.0), 0.0)
    assert anchor.position_at(10_000.0)[0] == pytest.approx((-100.0, 42.0))


def anchor_with(
    *,
    coords: tuple[Coordinate, ...] | None = None,
    cum_mi: tuple[float, ...] | None = None,
    cum_s: tuple[float, ...] | None = None,
    departure: datetime = DEPARTURE,
) -> ScenarioAnchor:
    """The two-hour route with some parts replaced."""
    good = two_hour_route()
    return ScenarioAnchor(
        good.coords if coords is None else coords,
        good.cum_mi if cum_mi is None else cum_mi,
        good.cum_s if cum_s is None else cum_s,
        departure,
    )


BAD_ANCHORS = {
    "one-coordinate": (
        lambda: anchor_with(coords=((-100.0, 40.0),), cum_mi=(0.0,), cum_s=(0.0,)),
        "at least two",
    ),
    "short-miles": (lambda: anchor_with(cum_mi=(0.0, 1.0)), "same length"),
    "short-seconds": (lambda: anchor_with(cum_s=(0.0, 1.0)), "same length"),
    "nan-miles": (lambda: anchor_with(cum_mi=(0.0, math.nan, 2.0)), "cum_mi must be finite"),
    "negative-miles": (lambda: anchor_with(cum_mi=(-1.0, 1.0, 2.0)), "cum_mi must be finite"),
    "infinite-seconds": (
        lambda: anchor_with(cum_s=(0.0, math.inf, 7200.0)),
        "cum_s must be finite",
    ),
    "decreasing-miles": (lambda: anchor_with(cum_mi=(0.0, 2.0, 1.0)), "cum_mi must not decrease"),
    "decreasing-seconds": (
        lambda: anchor_with(cum_s=(0.0, 3600.0, 3599.0)),
        "cum_s must not decrease",
    ),
    "no-length": (lambda: anchor_with(cum_mi=(0.0, 0.0, 0.0)), "positive length"),
    "latitude-off-the-globe": (
        lambda: anchor_with(coords=((-100.0, 40.0), (-100.0, 91.0), (-100.0, 42.0))),
        "valid range",
    ),
    "longitude-off-the-globe": (
        lambda: anchor_with(coords=((-181.0, 40.0), (-100.0, 41.0), (-100.0, 42.0))),
        "valid range",
    ),
    "nan-coordinate": (
        lambda: anchor_with(coords=((math.nan, 40.0), (-100.0, 41.0), (-100.0, 42.0))),
        "valid range",
    ),
    "naive-departure": (
        lambda: anchor_with(departure=DEPARTURE.replace(tzinfo=None)),
        "timezone-aware",
    ),
}


@pytest.mark.parametrize(("build", "message"), list(BAD_ANCHORS.values()), ids=list(BAD_ANCHORS))
def test_an_anchor_that_is_not_a_route_is_refused(
    build: Callable[[], ScenarioAnchor], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        build()


# ----------------------------------------------------------------------- the intensities


@pytest.mark.parametrize(
    ("hours", "expected"),
    [
        (-3.0, 0.0),  # before the window
        (-1.5, 0.0),  # the window opens at zero intensity
        (-1.0, 0.5),  # halfway up the ramp
        (-0.5, 1.0),  # the ramp is complete
        (0.0, 1.0),
        (2.0, 1.0),  # the fade-out starts
        (2.5, 0.5),  # halfway down
        (3.0, 0.0),  # closed
        (3.5, 0.0),  # after the window
    ],
)
def test_temporal_intensity_ramps_in_holds_and_ramps_out(hours: float, expected: float) -> None:
    assert temporal_intensity(WINDOW, hours) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("hours", "expected"), [(-2.1, 0.0), (-2.0, 1.0), (0.0, 1.0), (2.0, 1.0), (2.1, 0.0)]
)
def test_a_window_without_ramps_is_on_or_off_inclusive_of_both_ends(
    hours: float, expected: float
) -> None:
    assert (
        temporal_intensity(ActiveWindow(start_offset_h=-2, end_offset_h=2, ramp_h=0), hours)
        == expected
    )


@pytest.mark.parametrize(
    ("distance", "expected"),
    [(0.0, 1.0), (10.0, 1.0), (12.5, 0.75), (15.0, 0.5), (20.0, 0.0), (35.0, 0.0)],
)
def test_spatial_intensity_is_one_in_the_core_and_falls_off_linearly_to_the_radius(
    distance: float, expected: float
) -> None:
    assert spatial_intensity(distance, radius_mi=20.0, core_fraction=0.5) == pytest.approx(expected)


def test_without_a_core_the_fall_off_starts_at_the_centre() -> None:
    assert spatial_intensity(0.0, 20.0, 0.0) == 1.0
    assert spatial_intensity(5.0, 20.0, 0.0) == pytest.approx(0.75)


@given(
    distance=st.floats(0.0, 1_000.0),
    radius=st.floats(0.01, 400.0),
    core=st.floats(0.0, 0.999),
)
def test_spatial_intensity_stays_in_range_and_never_grows_with_distance(
    distance: float, radius: float, core: float
) -> None:
    here = spatial_intensity(distance, radius, core)
    farther = spatial_intensity(distance + 1.0, radius, core)
    assert 0.0 <= here <= 1.0
    assert farther <= here


@given(
    start=st.floats(-100.0, 100.0),
    length=st.floats(0.01, 60.0),
    share=st.floats(0.0, 0.5),
    at=st.floats(-200.0, 200.0),
)
def test_temporal_intensity_stays_in_range(
    start: float, length: float, share: float, at: float
) -> None:
    window = ActiveWindow(start_offset_h=start, end_offset_h=start + length, ramp_h=share * length)
    assert 0.0 <= temporal_intensity(window, at) <= 1.0


@pytest.mark.parametrize(
    ("bearing", "miles"), [(0.0, 69.09), (90.0, 50.0), (180.0, 10.0), (270.0, 120.0), (45.0, 300.0)]
)
def test_displacement_moves_the_requested_great_circle_distance(
    bearing: float, miles: float
) -> None:
    origin: Coordinate = (-100.0, 41.0)

    moved = displaced(origin, bearing, miles)

    assert haversine_mi(origin, moved) == pytest.approx(miles, rel=1e-9)


def test_displacement_goes_north_east_south_and_west() -> None:
    origin: Coordinate = (-100.0, 41.0)
    north, east = displaced(origin, 0.0, 50.0), displaced(origin, 90.0, 50.0)
    south, west = displaced(origin, 180.0, 50.0), displaced(origin, 270.0, 50.0)

    assert north[1] > 41.0
    assert north[0] == pytest.approx(-100.0)
    assert east[0] > -100.0
    assert east[1] == pytest.approx(41.0, abs=0.1)
    assert south[1] < 41.0
    assert west[0] < -100.0


def test_displacement_across_the_antimeridian_wraps_the_longitude() -> None:
    lon, lat = displaced((179.9, 0.0), 90.0, 100.0)

    assert -180.0 <= lon < -178.0
    assert lat == pytest.approx(0.0, abs=1e-9)


def test_no_distance_means_no_movement() -> None:
    assert displaced((-100.0, 41.0), 123.0, 0.0) == pytest.approx((-100.0, 41.0))


# --------------------------------------------------------------------- the provider itself


def test_the_provider_is_named_after_its_model_and_covers_the_requested_window() -> None:
    provider = provider_of(cell())
    point = LatticePoint(411, -1000)

    forecasts = provider.fetch([point, CENTRE], EIGHT_HOURS)

    assert provider.name == provider.model == "scenario"
    assert list(forecasts) == [point, CENTRE]
    forecast = forecasts[point]
    assert forecast.window == EIGHT_HOURS
    assert forecast.model == "scenario"
    assert forecast.point == point
    assert (forecast.source_lat, forecast.source_lon) == (point.lat, point.lon)
    assert forecast.elevation_m is None


def test_no_points_means_no_forecasts() -> None:
    assert provider_of(cell()).fetch([], EIGHT_HOURS) == {}


def test_a_repeated_point_is_answered_once() -> None:
    forecasts = provider_of(cell()).fetch([CENTRE, CENTRE], EIGHT_HOURS)

    assert list(forecasts) == [CENTRE]


def test_without_cells_the_baseline_holds_everywhere_and_every_hour() -> None:
    provider = provider_of()
    far_away = LatticePoint(-250, 1200)

    for point in (CENTRE, far_away):
        forecast = forecast_at(provider, point)
        assert set(forecast.wind_speed_mph) == {10.0}
        assert set(forecast.wind_gust_mph) == {16.0}
        assert set(forecast.rain_in) == {0.0}
        assert set(forecast.snowfall_in) == {0.0}
        assert set(forecast.temperature_f) == {50.0}
        assert set(forecast.weather_code) == {1}


def test_at_the_core_the_cell_ramps_in_peaks_and_fades_out_around_the_anchor_eta() -> None:
    forecast = forecast_at(provider_of(cell()), CENTRE)

    # stamps 10:00Z .. 17:00Z; the truck passes the anchor at 13:00Z
    assert forecast.wind_speed_mph == (10.0, 10.0, 25.0, 40.0, 40.0, 40.0, 10.0, 10.0)
    assert forecast.wind_gust_mph == (16.0, 16.0, 36.0, 56.0, 56.0, 56.0, 16.0, 16.0)
    assert forecast.rain_in == (0.0, 0.0, 0.2, 0.4, 0.4, 0.4, 0.0, 0.0)
    assert forecast.snowfall_in == (0.0, 0.0, 1.0, 2.0, 2.0, 2.0, 0.0, 0.0)
    assert forecast.temperature_f == (50.0, 50.0, 35.0, 20.0, 20.0, 20.0, 50.0, 50.0)
    assert forecast.weather_code == (1, 1, 75, 75, 75, 75, 1, 1)
    assert forecast.showers_in == (0.0,) * 8


def test_precipitation_is_rain_plus_the_water_equivalent_of_snow() -> None:
    forecast = forecast_at(provider_of(cell()), CENTRE)

    assert forecast.precipitation_in[3] == round(0.4 + 2.0 / 7.0, 3) == 0.686
    assert forecast.precipitation_in[0] == 0.0


def test_the_effect_falls_off_with_distance_from_the_centre() -> None:
    provider = provider_of(cell())
    inside_core = LatticePoint(411, -1000)  # 6.9 mi north: within the 10 mi core
    in_the_fade = LatticePoint(412, -1000)  # 13.8 mi north
    beyond = LatticePoint(413, -1000)  # 20.7 mi north: outside the 20 mi radius

    assert forecast_at(provider, inside_core).wind_speed_mph[3] == 40.0
    fade = (20.0 - haversine_mi((-100.0, 41.2), (-100.0, 41.0))) / 10.0
    assert forecast_at(provider, in_the_fade).wind_speed_mph[3] == round(10.0 + 30.0 * fade, 1)
    assert forecast_at(provider, in_the_fade).wind_speed_mph[3] == 28.5
    assert forecast_at(provider, beyond).wind_speed_mph[3] == 10.0


def test_an_intensity_of_exactly_one_half_is_half_way_between_baseline_and_peak() -> None:
    point = LatticePoint(411, -1000)
    distance = haversine_mi((point.lon, point.lat), (-100.0, 41.0))
    provider = provider_of(cell(place=(0.5, 2 * distance, 0.0)))

    forecast = forecast_at(provider, point)

    assert forecast.wind_speed_mph[3] == 25.0
    assert forecast.weather_code[3] == 75  # exactly CODE_THRESHOLD: the cell's code wins
    assert CODE_THRESHOLD == 0.5


def test_below_the_code_threshold_the_baseline_code_stays_but_temperature_blends() -> None:
    point = LatticePoint(411, -1000)
    distance = haversine_mi((point.lon, point.lat), (-100.0, 41.0))
    provider = provider_of(cell(place=(0.5, 1.5 * distance, 0.0)))  # intensity 1/3

    forecast = forecast_at(provider, point)

    assert forecast.weather_code[3] == 1
    assert forecast.temperature_f[3] == 40.0  # 50 - 30 / 3
    assert forecast.wind_speed_mph[3] == 20.0  # 10 + 30 / 3


def test_values_are_rounded_to_tenths_and_thousandths() -> None:
    point = LatticePoint(411, -1000)
    distance = haversine_mi((point.lon, point.lat), (-100.0, 41.0))
    peak = Conditions(
        wind_mph=41.0,
        gust_mph=57.0,
        rain_in_hr=0.4,
        snow_in_hr=2.0,
        temperature_f=20.0,
        weather_code=75,
    )
    provider = provider_of(cell(place=(0.5, 1.5 * distance, 0.0), peak=peak))

    forecast = forecast_at(provider, point)

    assert forecast.wind_speed_mph[3] == 20.3  # 20.333...
    assert forecast.wind_gust_mph[3] == 29.7  # 16 + 41 / 3 = 29.666...
    assert forecast.rain_in[3] == 0.133
    assert forecast.snowfall_in[3] == 0.667


def test_a_cell_can_only_add_weather_never_remove_it() -> None:
    gentle = Conditions(
        wind_mph=5.0,
        gust_mph=6.0,
        rain_in_hr=0.0,
        snow_in_hr=0.0,
        temperature_f=50.0,
        weather_code=1,
    )

    forecast = forecast_at(provider_of(cell(peak=gentle)), CENTRE)

    assert set(forecast.wind_speed_mph) == {10.0}
    assert set(forecast.wind_gust_mph) == {16.0}


def test_overlapping_cells_take_the_strongest_value_per_variable() -> None:
    gale = Conditions(
        wind_mph=45.0,
        gust_mph=60.0,
        rain_in_hr=0.0,
        snow_in_hr=0.0,
        temperature_f=60.0,
        weather_code=95,
    )
    downpour = Conditions(
        wind_mph=15.0,
        gust_mph=20.0,
        rain_in_hr=0.8,
        snow_in_hr=0.0,
        temperature_f=70.0,
        weather_code=65,
    )
    provider = provider_of(cell("gale", peak=gale), cell("rain", peak=downpour))

    forecast = forecast_at(provider, CENTRE)

    assert forecast.wind_speed_mph[3] == 45.0
    assert forecast.wind_gust_mph[3] == 60.0
    assert forecast.rain_in[3] == 0.8
    # both at full intensity: the first listed cell is dominant for temperature and code
    assert (forecast.temperature_f[3], forecast.weather_code[3]) == (60.0, 95)


def test_the_dominant_cell_is_the_one_with_the_highest_intensity() -> None:
    slow = ActiveWindow(start_offset_h=-1.5, end_offset_h=3.0, ramp_h=1.0)  # 0.5 at 12:00Z
    early = ActiveWindow(start_offset_h=-3.0, end_offset_h=3.0, ramp_h=0.5)  # 1.0 at 12:00Z
    first = cell("first", window=slow, peak=PEAK)
    second = cell("second", window=early, peak=BASELINE.model_copy(update={"weather_code": 61}))

    forecast = forecast_at(provider_of(first, second), CENTRE)

    assert forecast.weather_code[2] == 61  # at 12:00Z the second cell is at full intensity


def test_a_moving_cell_leaves_where_it_was_and_arrives_where_it_goes() -> None:
    north = Motion(bearing_deg=0.0, speed_mph=60.0)
    still = provider_of(cell())
    moving = provider_of(cell(motion=north))
    ahead = LatticePoint(414, -1000)  # about 28 mi north of the anchor

    # 12:00Z is half an hour after the window opened at 11:30Z: the cell has moved 30 miles
    assert forecast_at(still, CENTRE).wind_speed_mph[2] == 25.0
    assert forecast_at(moving, CENTRE).wind_speed_mph[2] == 10.0
    assert forecast_at(moving, ahead).wind_speed_mph[2] == 25.0
    assert forecast_at(still, ahead).wind_speed_mph[2] == 10.0


def test_a_moving_cell_does_not_move_before_its_window_opens() -> None:
    north = Motion(bearing_deg=0.0, speed_mph=60.0)

    forecast = forecast_at(provider_of(cell(motion=north)), CENTRE, HourWindow(DEPARTURE, 2))

    # 12:00Z is within the ramp-in; at the window start (11:30Z) the cell was still at its anchor
    assert forecast.wind_speed_mph[0] == 10.0


def test_a_cell_that_never_overlaps_the_window_costs_nothing_and_changes_nothing() -> None:
    late = ActiveWindow(start_offset_h=100.0, end_offset_h=110.0, ramp_h=1.0)

    forecast = forecast_at(provider_of(cell(window=late)), CENTRE)

    assert set(forecast.wind_speed_mph) == {10.0}


def test_identical_inputs_give_identical_forecasts() -> None:
    first = provider_of(cell(), cell("rear", place=(0.2, 60.0, 0.5))).fetch(
        [CENTRE, LatticePoint(405, -1002)], EIGHT_HOURS
    )
    second = provider_of(cell(), cell("rear", place=(0.2, 60.0, 0.5))).fetch(
        [CENTRE, LatticePoint(405, -1002)], EIGHT_HOURS
    )

    assert first == second


def test_a_large_request_is_evaluated_without_trouble() -> None:
    provider = provider_of(
        cell(), cell("b", place=(0.2, 20.0, 0.5)), cell("c", place=(0.8, 20.0, 0.5))
    )
    points = [LatticePoint(400 + lat, -1010 + lon) for lat in range(50) for lon in range(5)]
    window = HourWindow(datetime(2026, 10, 20, 12, tzinfo=UTC), 49)

    started = time.perf_counter()
    forecasts = provider.fetch(points, window)

    assert len(forecasts) == 250
    assert all(item.hours == 49 for item in forecasts.values())
    assert time.perf_counter() - started < 15.0  # a tripwire for accidental quadratic work


# ------------------------------------------------------------------- the shipped scenarios


def at(series: Sequence[float | None], hour: int) -> float:
    """Return ``series[hour]``, which a scenario forecast never leaves missing."""
    value = series[hour]
    assert value is not None
    return value


def band(factor: str, value: float) -> str:
    """Classify ``value`` with the shared risk rules (an independent reading of the bands)."""
    rules = json.loads((shared_dir() / "risk-rules.json").read_text(encoding="utf-8"))
    for item in rules["factors"][factor]["bands"]:
        lower_ok = ("min_inclusive" not in item or value >= item["min_inclusive"]) and (
            "min_exclusive" not in item or value > item["min_exclusive"]
        )
        upper_ok = ("max_inclusive" not in item or value <= item["max_inclusive"]) and (
            "max_exclusive" not in item or value < item["max_exclusive"]
        )
        if lower_ok and upper_ok:
            return str(item["level"])
    raise AssertionError(f"{value} fits no {factor} band")


def real_anchor(fixture: str) -> ScenarioAnchor:
    """The first recorded Valhalla route of ``fixture`` as the fastest-route anchor."""
    provider = test_valhalla.provider_for(
        test_valhalla.ValhallaDouble(fixture),
        policy=DiversityPolicy(max_extra_calls=0),
        clock=FakeClock(),
    )
    route = provider.route((0.0, 0.0), (0.0, 1.0), load_weight_lb=0).routes[0]
    steps = [haversine_mi(a, b) for a, b in zip(route.coords, route.coords[1:], strict=False)]
    raw = [0.0]
    for step in steps:
        raw.append(raw[-1] + step)
    scale = route.distance_mi / raw[-1]
    return ScenarioAnchor(
        route.coords, tuple(value * scale for value in raw), route.cum_s, DEPARTURE
    )


TRIPS = [
    "valhalla-slc-den-truck-alt2.json",
    "valhalla-chi-den-truck-alt2.json",
    "valhalla-dal-atl-truck-alt2.json",
]


def conditions_at_anchor(
    anchor: ScenarioAnchor, scenario: Scenario, fraction: float
) -> tuple[Conditions, HourlyForecast, int]:
    """The forecast at the lattice point nearest ``fraction`` of the route, at the nearest hour."""
    centre, elapsed_s = anchor.position_at(fraction * anchor.cum_mi[-1])
    eta = anchor.departure + timedelta(seconds=elapsed_s)
    start = (eta - timedelta(hours=12)).replace(minute=0, second=0, microsecond=0)
    window = HourWindow(start, 25)
    nearest = LatticePoint(round(centre[1] * 10), round(centre[0] * 10))
    forecast = ScenarioWeatherProvider(scenario, anchor).fetch([nearest], window)[nearest]
    hour = round((eta - start).total_seconds() / 3600)
    return scenario.baseline, forecast, hour


@pytest.mark.parametrize("fixture", TRIPS)
def test_the_snowstorm_is_severe_on_the_fastest_route_and_absent_far_away(fixture: str) -> None:
    anchor = real_anchor(fixture)
    scenario = ScenarioCatalog.load().get("storm-on-fastest")

    baseline, forecast, hour = conditions_at_anchor(anchor, scenario, 0.5)

    assert band("snow", at(forecast.snowfall_in, hour)) == "severe"
    assert band("wind", at(forecast.wind_speed_mph, hour)) == "high"
    far = LatticePoint(250, -600)
    window = HourWindow(datetime(2026, 10, 20, 12, tzinfo=UTC), 24)
    elsewhere = ScenarioWeatherProvider(scenario, anchor).fetch([far], window)[far]
    assert set(elsewhere.wind_speed_mph) == {baseline.wind_mph}
    assert set(elsewhere.snowfall_in) == {0.0}


@pytest.mark.parametrize("fixture", TRIPS)
def test_the_wind_corridor_is_a_severe_sustained_wind_that_stops_short_of_no_travel(
    fixture: str,
) -> None:
    anchor = real_anchor(fixture)
    scenario = ScenarioCatalog.load().get("high-wind-corridor")

    _, forecast, hour = conditions_at_anchor(anchor, scenario, 0.5)

    assert band("wind", at(forecast.wind_speed_mph, hour)) == "severe"
    assert 45.0 <= at(forecast.wind_speed_mph, hour) <= 54.9


@pytest.mark.parametrize("fixture", TRIPS)
def test_the_downpour_bands_rise_from_moderate_to_severe_along_the_trip(fixture: str) -> None:
    anchor = real_anchor(fixture)
    scenario = ScenarioCatalog.load().get("gulf-downpour")

    levels = []
    for fraction in (0.30, 0.50, 0.70):
        _, forecast, hour = conditions_at_anchor(anchor, scenario, fraction)
        levels.append(band("rain", at(forecast.rain_in, hour)))

    assert levels == ["moderate", "high", "severe"]


@pytest.mark.parametrize("fixture", TRIPS)
def test_the_calm_scenario_is_benign_everywhere(fixture: str) -> None:
    anchor = real_anchor(fixture)
    scenario = ScenarioCatalog.load().get("calm")

    _, forecast, hour = conditions_at_anchor(anchor, scenario, 0.5)

    assert band("wind", at(forecast.wind_speed_mph, hour)) == "low"
    assert band("rain", at(forecast.rain_in, hour)) == "low"
    assert band("snow", at(forecast.snowfall_in, hour)) == "low"
