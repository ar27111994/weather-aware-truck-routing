"""Deterministic scenario weather: evaluate a scenario's storm cells into hourly forecasts.

:class:`ScenarioWeatherProvider` is a :class:`~haulcast.providers.weather.base.WeatherProvider`
that never touches the network: it turns a validated :class:`~haulcast.providers.weather.scenarios.
Scenario` plus the trip's **fastest route** (:class:`ScenarioAnchor`) into the same
:class:`~haulcast.providers.weather.base.HourlyForecast` objects Open-Meteo would produce. Cells
are placed relative to that route, so a scenario demonstrates the logic on any origin and
destination.

**Where and when a cell acts.** A cell is centred where the fastest route is at ``fraction`` of
its length. Its ``window`` is measured in hours relative to the ETA *at that anchor point*
(``departure + travel time to the anchor``). Temporal intensity is 0 outside the window, ramps
linearly 0 to 1 over the first ``ramp_h`` hours and 1 to 0 over the last ``ramp_h`` hours, and is 1
in between (with ``ramp_h == 0`` the window is simply on or off, inclusive of both ends). Spatial
intensity is 1 within ``core_fraction * radius_mi`` of the cell centre, falls off linearly to 0 at
``radius_mi`` and is 0 beyond. The cell's intensity is their product.

**Motion.** A cell with ``motion`` is stationary until its window starts, then its centre drifts
along the great circle with the given bearing (degrees clockwise from north) at ``speed_mph``, so
``hours since the window started * speed_mph`` miles from its anchor position.

**Conditions at a place and an hour.** Wind, gust, rain and snow are the maximum over the baseline
and every cell's ``baseline + intensity * (peak - baseline)``: a cell can only add weather, and
overlapping cells never add up beyond the strongest. Temperature blends the same way towards the
*dominant* cell's peak (the highest intensity; the first listed wins ties), and the weather code is
that cell's code once its intensity reaches one half, else the baseline's. Showers are zero and
``precipitation`` is rain plus the water equivalent of snow (one seventh, as Open-Meteo documents).
Values are rounded to 0.1 (mph, deg F) and 0.001 (inches) so output is stable at band edges.

Everything is a pure function of the scenario, the route and the requested points and hours: no
randomness, no clock, no I/O. Every variable is evaluated at the stamped instant: scenario values
are synthetic, so there is no preceding-hour subtlety to model.
"""

import math
import sys
from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from itertools import pairwise
from typing import Final

from haulcast.geo import MAX_LAT, MAX_LON
from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.geometry import EARTH_RADIUS_MI, haversine_mi
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint
from haulcast.providers.weather.scenarios import ActiveWindow, Conditions, Scenario, StormCell

PROVIDER_NAME: Final = "scenario"
MODEL_NAME: Final = "scenario"
CODE_THRESHOLD: Final = 0.5
"""Intensity from which the dominant cell's weather code replaces the baseline's."""
SNOW_WATER_DIVISOR: Final = 7.0
"""Inches of snow per inch of water, as Open-Meteo documents (7 cm of snow is 1 mm of water)."""

_MIN_COORDINATES: Final = 2
"""A route needs at least a start and an end."""
_SECONDS_PER_HOUR: Final = 3600.0
_FULL_CIRCLE_DEG: Final = 360.0
_HALF_CIRCLE_DEG: Final = 180.0


@dataclass(frozen=True, slots=True)
class ScenarioAnchor:
    """The trip's fastest route: where scenario cells are anchored and when the truck gets there.

    ``coords`` are ``(lon, lat)``; ``cum_mi`` and ``cum_s`` are the cumulative miles and seconds at
    each coordinate (the arrays of ``haulcast.domain.RoutePath``); ``departure`` is timezone-aware.
    """

    coords: tuple[Coordinate, ...]
    cum_mi: tuple[float, ...]
    cum_s: tuple[float, ...]
    departure: datetime

    def __post_init__(self) -> None:
        """Validate shapes, finiteness, monotonicity, ranges and the departure's time zone."""
        count = len(self.coords)
        if count < _MIN_COORDINATES:
            raise ValueError("an anchor route needs at least two coordinates")
        if len(self.cum_mi) != count or len(self.cum_s) != count:
            raise ValueError("coords, cum_mi and cum_s must have the same length")
        for name, series in (("cum_mi", self.cum_mi), ("cum_s", self.cum_s)):
            if not all(math.isfinite(value) and value >= 0 for value in series):
                raise ValueError(f"{name} must be finite and not negative")
            if any(later < earlier for earlier, later in pairwise(series)):
                raise ValueError(f"{name} must not decrease")
        if self.cum_mi[-1] <= 0:
            raise ValueError("the route must have a positive length")
        if not all(
            math.isfinite(lon)
            and math.isfinite(lat)
            and abs(lat) <= MAX_LAT
            and abs(lon) <= MAX_LON
            for lon, lat in self.coords
        ):
            raise ValueError("coordinates must be finite and inside the valid range")
        if self.departure.tzinfo is None or self.departure.utcoffset() is None:
            raise ValueError("departure must be timezone-aware")

    def position_at(self, distance_mi: float) -> tuple[Coordinate, float]:
        """Return ``((lon, lat), elapsed seconds)`` at ``distance_mi`` along the route (clamped)."""
        distance = min(max(distance_mi, 0.0), self.cum_mi[-1])
        upper = bisect_left(self.cum_mi, distance)
        if upper == 0:
            return self.coords[0], self.cum_s[0]
        lower = upper - 1
        share = (distance - self.cum_mi[lower]) / (self.cum_mi[upper] - self.cum_mi[lower])
        (lon_a, lat_a), (lon_b, lat_b) = self.coords[lower], self.coords[upper]
        return (
            (lon_a + (lon_b - lon_a) * share, lat_a + (lat_b - lat_a) * share),
            self.cum_s[lower] + (self.cum_s[upper] - self.cum_s[lower]) * share,
        )


def temporal_intensity(window: ActiveWindow, hours: float) -> float:
    """Return the intensity in ``[0, 1]`` of a window at ``hours`` after the anchor ETA."""
    start, end, ramp = window.start_offset_h, window.end_offset_h, window.ramp_h
    if hours < start or hours > end:
        return 0.0
    if ramp == 0:
        return 1.0
    if hours < start + ramp:
        return (hours - start) / ramp
    if hours > end - ramp:
        return (end - hours) / ramp
    return 1.0


def spatial_intensity(distance_mi: float, radius_mi: float, core_fraction: float) -> float:
    """Return the intensity in ``[0, 1]`` at ``distance_mi`` from the centre of a cell."""
    core = core_fraction * radius_mi
    if distance_mi <= core:
        return 1.0
    if distance_mi >= radius_mi:
        return 0.0
    return (radius_mi - distance_mi) / (radius_mi - core)


def displaced(origin: Coordinate, bearing_deg: float, distance_mi: float) -> Coordinate:
    """Return the ``(lon, lat)`` reached from ``origin`` after ``distance_mi`` on a bearing.

    The great-circle destination-point formula on a sphere of radius ``EARTH_RADIUS_MI``; the
    longitude is normalised to ``[-180, 180)``.
    """
    lon1, lat1 = math.radians(origin[0]), math.radians(origin[1])
    bearing = math.radians(bearing_deg)
    angle = distance_mi / EARTH_RADIUS_MI
    lat2 = math.asin(
        math.sin(lat1) * math.cos(angle) + math.cos(lat1) * math.sin(angle) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angle) * math.cos(lat1),
        math.cos(angle) - math.sin(lat1) * math.sin(lat2),
    )
    lon = (math.degrees(lon2) + _HALF_CIRCLE_DEG) % _FULL_CIRCLE_DEG - _HALF_CIRCLE_DEG
    return lon, math.degrees(lat2)


def _blend(baseline: float, peak: float, intensity: float) -> float:
    return baseline + intensity * (peak - baseline)


@dataclass(frozen=True, slots=True)
class _PlacedCell:
    """A storm cell pinned to the trip: its centre and the anchor ETA its window refers to."""

    cell: StormCell
    centre: Coordinate
    eta: datetime

    @classmethod
    def place(cls, cell: StormCell, anchor: ScenarioAnchor) -> "_PlacedCell":
        centre, elapsed_s = anchor.position_at(cell.fraction * anchor.cum_mi[-1])
        return cls(cell, centre, anchor.departure + timedelta(seconds=elapsed_s))

    def temporal(self, stamp: datetime) -> float:
        return temporal_intensity(
            self.cell.window, (stamp - self.eta).total_seconds() / _SECONDS_PER_HOUR
        )

    def spatial(self, point: Coordinate, stamp: datetime) -> float:
        """Spatial intensity at ``point``; the centre has drifted if the cell moves."""
        centre = self.centre
        motion = self.cell.motion
        if motion is not None:
            started = self.eta + timedelta(hours=self.cell.window.start_offset_h)
            hours = max(0.0, (stamp - started).total_seconds() / _SECONDS_PER_HOUR)
            centre = displaced(self.centre, motion.bearing_deg, motion.speed_mph * hours)
        return spatial_intensity(
            haversine_mi(point, centre), self.cell.radius_mi, self.cell.core_fraction
        )


class ScenarioWeatherProvider:
    """Hourly forecasts from a scenario, anchored on the trip's fastest route."""

    name = PROVIDER_NAME
    model = MODEL_NAME
    max_points = sys.maxsize
    """A synthetic source has no request-size limit: one call answers for every point."""

    def __init__(self, scenario: Scenario, anchor: ScenarioAnchor) -> None:
        """Pin every cell of ``scenario`` to ``anchor`` (centres and anchor ETAs)."""
        self._baseline = scenario.baseline
        self._cells = tuple(_PlacedCell.place(cell, anchor) for cell in scenario.cells)

    def fetch(
        self,
        points: Sequence[LatticePoint],
        window: HourWindow,
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """Return one forecast per distinct requested point, each covering exactly ``window``."""
        stamps = [window.start + timedelta(hours=hour) for hour in range(window.hours)]
        temporal = [[placed.temporal(stamp) for stamp in stamps] for placed in self._cells]
        return {
            point: self._forecast(point, window, stamps, temporal)
            for point in dict.fromkeys(points)
        }

    def _forecast(
        self,
        point: LatticePoint,
        window: HourWindow,
        stamps: list[datetime],
        temporal: list[list[float]],
    ) -> HourlyForecast:
        rows = [self._conditions(point, stamp, hour, temporal) for hour, stamp in enumerate(stamps)]
        wind, gust, rain, snow, temperature, code = (
            tuple(column) for column in zip(*rows, strict=True)
        )
        return HourlyForecast(
            point=point,
            model=MODEL_NAME,
            start=window.start,
            wind_speed_mph=wind,
            wind_gust_mph=gust,
            rain_in=rain,
            showers_in=tuple(0.0 for _ in stamps),
            snowfall_in=snow,
            precipitation_in=tuple(
                round(rain_in + snow_in / SNOW_WATER_DIVISOR, 3)
                for rain_in, snow_in in zip(rain, snow, strict=True)
            ),
            temperature_f=temperature,
            weather_code=code,
            source_lat=point.lat,
            source_lon=point.lon,
        )

    def _conditions(
        self, point: LatticePoint, stamp: datetime, hour: int, temporal: list[list[float]]
    ) -> tuple[float, float, float, float, float, int]:
        """Wind, gust, rain, snow, temperature and code at ``point`` at ``stamp`` (rounded)."""
        base: Conditions = self._baseline
        wind, gust, rain, snow = base.wind_mph, base.gust_mph, base.rain_in_hr, base.snow_in_hr
        dominant: tuple[float, Conditions] | None = None
        place: Coordinate = (point.lon, point.lat)
        for placed, series in zip(self._cells, temporal, strict=True):
            if series[hour] == 0.0:
                continue
            intensity = series[hour] * placed.spatial(place, stamp)
            if intensity <= 0.0:
                continue
            peak = placed.cell.peak
            wind = max(wind, _blend(base.wind_mph, peak.wind_mph, intensity))
            gust = max(gust, _blend(base.gust_mph, peak.gust_mph, intensity))
            rain = max(rain, _blend(base.rain_in_hr, peak.rain_in_hr, intensity))
            snow = max(snow, _blend(base.snow_in_hr, peak.snow_in_hr, intensity))
            if dominant is None or intensity > dominant[0]:
                dominant = (intensity, peak)
        temperature, code = base.temperature_f, base.weather_code
        if dominant is not None:
            intensity, peak = dominant
            temperature = _blend(base.temperature_f, peak.temperature_f, intensity)
            if intensity >= CODE_THRESHOLD:
                code = peak.weather_code
        return (
            round(wind, 1),
            round(gust, 1),
            round(rain, 3),
            round(snow, 3),
            round(temperature, 1),
            code,
        )
