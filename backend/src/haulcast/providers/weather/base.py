"""Provider-neutral weather types: the 0.1 degree lattice, hour windows and hourly forecasts.

**Location-key quantisation (decision D-19).** Open-Meteo bills at least one call per *location*, so
every weather lookup snaps to the nearest point of a 0.1 degree lattice (about 7 miles, the same
order as the 3-13 km grids of the underlying models). The lattice point is the cache key and is
shared by all routes' checkpoints and by the heatmap, whose grid spacing is a multiple of 0.1
degrees aligned to the same lattice. Ties snap upward (half-up on the floating-point product), so
the mapping is deterministic everywhere it is used.
"""

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Protocol, Self

LATTICE_STEPS_PER_DEGREE: Final = 10
"""The lattice has ten points per degree: a 0.1 degree step."""

MAX_LAT_E1: Final = 90 * LATTICE_STEPS_PER_DEGREE
MAX_LON_E1: Final = 180 * LATTICE_STEPS_PER_DEGREE
MAX_WINDOW_HOURS: Final = 16 * 24
"""Open-Meteo forecasts reach 16 days; a window can never usefully be longer."""

PAYLOAD_VERSION: Final = 1
_SECONDS_PER_HOUR: Final = 3600

# Open-Meteo variable names double as the keys of the cache payload.
WIND_VARIABLE: Final = "wind_speed_10m"
GUST_VARIABLE: Final = "wind_gusts_10m"
RAIN_VARIABLE: Final = "rain"
SHOWERS_VARIABLE: Final = "showers"
SNOWFALL_VARIABLE: Final = "snowfall"
PRECIPITATION_VARIABLE: Final = "precipitation"
TEMPERATURE_VARIABLE: Final = "temperature_2m"
WEATHER_CODE_VARIABLE: Final = "weather_code"
VARIABLES: Final = (
    WIND_VARIABLE,
    GUST_VARIABLE,
    RAIN_VARIABLE,
    SHOWERS_VARIABLE,
    SNOWFALL_VARIABLE,
    PRECIPITATION_VARIABLE,
    TEMPERATURE_VARIABLE,
    WEATHER_CODE_VARIABLE,
)
"""The eight hourly variables fetched per location (weight 1 per location at Open-Meteo)."""


class LatticeError(ValueError):
    """A coordinate cannot be mapped onto the lattice (not finite or out of range)."""


class ForecastPayloadError(ValueError):
    """A stored forecast payload is malformed (treated by callers as a cache miss)."""


@dataclass(frozen=True, slots=True, order=True)
class LatticePoint:
    """A point of the 0.1 degree lattice, stored as integer tenths of a degree."""

    lat_e1: int
    lon_e1: int

    @property
    def lat(self) -> float:
        """Latitude in degrees."""
        return self.lat_e1 / LATTICE_STEPS_PER_DEGREE

    @property
    def lon(self) -> float:
        """Longitude in degrees."""
        return self.lon_e1 / LATTICE_STEPS_PER_DEGREE

    @property
    def key(self) -> str:
        """Stable cache key such as ``+397,-1050`` (39.7 N, 105.0 W)."""
        return f"{self.lat_e1:+d},{self.lon_e1:+d}"


def snap_to_lattice(lat: float, lon: float) -> LatticePoint:
    """Return the lattice point nearest to ``(lat, lon)``.

    Raises:
        LatticeError: a coordinate is not finite or outside ``[-90, 90]`` / ``[-180, 180]``.
    """
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise LatticeError("coordinates must be finite")
    lat_e1 = math.floor(lat * LATTICE_STEPS_PER_DEGREE + 0.5)
    lon_e1 = math.floor(lon * LATTICE_STEPS_PER_DEGREE + 0.5)
    if abs(lat_e1) > MAX_LAT_E1 or abs(lon_e1) > MAX_LON_E1:
        raise LatticeError("coordinates are outside the valid latitude/longitude range")
    return LatticePoint(lat_e1, lon_e1)


def floor_hour(moment: datetime) -> datetime:
    """Return ``moment`` (tz-aware) converted to UTC and truncated to the start of its hour."""
    return moment.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def ceil_hour(moment: datetime) -> datetime:
    """Return ``moment`` (tz-aware) converted to UTC and rounded up to a whole hour."""
    floored = floor_hour(moment)
    return floored if floored == moment.astimezone(UTC) else floored + timedelta(hours=1)


@dataclass(frozen=True, slots=True)
class HourWindow:
    """A run of consecutive UTC hours: ``hours`` stamps starting at ``start`` (inclusive)."""

    start: datetime
    hours: int

    def __post_init__(self) -> None:
        """Validate that ``start`` is a UTC hour boundary and ``hours`` is in range."""
        if self.start.tzinfo is None or self.start.utcoffset() != timedelta(0):
            raise ValueError("window start must be timezone-aware UTC")
        if self.start != floor_hour(self.start):
            raise ValueError("window start must be on the hour")
        if not 1 <= self.hours <= MAX_WINDOW_HOURS:
            raise ValueError(f"window must span 1..{MAX_WINDOW_HOURS} hours")

    @classmethod
    def covering(cls, first: datetime, last: datetime) -> Self:
        """Return the smallest window that contains ``first`` and ``last`` (tz-aware instants)."""
        start = floor_hour(first)
        end = ceil_hour(last)
        hours = int((end - start).total_seconds() // _SECONDS_PER_HOUR) + 1
        return cls(start, max(hours, 1))

    @property
    def end(self) -> datetime:
        """The last hourly stamp of the window (inclusive)."""
        return self.start + timedelta(hours=self.hours - 1)

    def covers(self, other: "HourWindow") -> bool:
        """Return whether every hour of ``other`` lies inside this window."""
        return self.start <= other.start and other.end <= self.end


Series = tuple[float | None, ...]
CodeSeries = tuple[int | None, ...]


@dataclass(frozen=True, slots=True)
class HourlyForecast:
    """Hourly weather at one lattice point: one value per hour per variable, ``None`` = missing.

    All arrays have the same length and ``start`` is the UTC hour of index 0. Units are already
    normalised: mph, inches (``snowfall`` too), degrees Fahrenheit, WMO weather codes. Instant
    variables (wind, temperature, code) describe the stamped hour; ``wind_gust_mph``, the rain,
    showers, snowfall and precipitation arrays describe the *preceding* hour (DOMAIN-CONTRACT 5).
    """

    point: LatticePoint
    model: str
    start: datetime
    wind_speed_mph: Series
    wind_gust_mph: Series
    rain_in: Series
    showers_in: Series
    snowfall_in: Series
    precipitation_in: Series
    temperature_f: Series
    weather_code: CodeSeries
    source_lat: float | None = None
    source_lon: float | None = None
    elevation_m: float | None = None

    def __post_init__(self) -> None:
        """Validate the start stamp and that every array has the same non-zero length."""
        if self.start.tzinfo is None or self.start != floor_hour(self.start):
            raise ValueError("forecast start must be a timezone-aware UTC hour")
        lengths = {len(values) for values in self._arrays()}
        if len(lengths) != 1 or 0 in lengths:
            raise ValueError("all forecast arrays must share one non-zero length")

    def _arrays(self) -> tuple[Sequence[object], ...]:
        return (
            self.wind_speed_mph,
            self.wind_gust_mph,
            self.rain_in,
            self.showers_in,
            self.snowfall_in,
            self.precipitation_in,
            self.temperature_f,
            self.weather_code,
        )

    @property
    def hours(self) -> int:
        """Number of hourly samples."""
        return len(self.wind_speed_mph)

    @property
    def window(self) -> HourWindow:
        """The :class:`HourWindow` this forecast covers."""
        return HourWindow(self.start, self.hours)

    def to_payload(self) -> dict[str, object]:
        """Serialise to the JSON document stored in the cache (Open-Meteo variable names)."""
        return {
            "v": PAYLOAD_VERSION,
            "start": int(self.start.timestamp()),
            "hours": self.hours,
            "source": {
                "lat": self.source_lat,
                "lon": self.source_lon,
                "elevation_m": self.elevation_m,
            },
            "series": {
                WIND_VARIABLE: list(self.wind_speed_mph),
                GUST_VARIABLE: list(self.wind_gust_mph),
                RAIN_VARIABLE: list(self.rain_in),
                SHOWERS_VARIABLE: list(self.showers_in),
                SNOWFALL_VARIABLE: list(self.snowfall_in),
                PRECIPITATION_VARIABLE: list(self.precipitation_in),
                TEMPERATURE_VARIABLE: list(self.temperature_f),
                WEATHER_CODE_VARIABLE: list(self.weather_code),
            },
        }

    @classmethod
    def from_payload(cls, point: LatticePoint, model: str, payload: object) -> Self:
        """Rebuild a forecast from :meth:`to_payload` output.

        Raises:
            ForecastPayloadError: the payload is not a valid version-1 document.
        """
        try:
            return cls._from_payload(point, model, payload)
        except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
            raise ForecastPayloadError("stored forecast payload is malformed") from exc

    @classmethod
    def _from_payload(cls, point: LatticePoint, model: str, payload: object) -> Self:
        if not isinstance(payload, dict) or payload["v"] != PAYLOAD_VERSION:
            raise TypeError("unsupported payload")
        series = payload["series"]
        source = payload["source"]
        hours = payload["hours"]
        if (
            not isinstance(series, dict)
            or not isinstance(source, dict)
            or not isinstance(hours, int)
        ):
            raise TypeError("unsupported payload")
        floats = {name: _float_series(series[name], hours) for name in VARIABLES[:-1]}
        return cls(
            point=point,
            model=model,
            start=datetime.fromtimestamp(_strict_int(payload["start"]), UTC),
            wind_speed_mph=floats[WIND_VARIABLE],
            wind_gust_mph=floats[GUST_VARIABLE],
            rain_in=floats[RAIN_VARIABLE],
            showers_in=floats[SHOWERS_VARIABLE],
            snowfall_in=floats[SNOWFALL_VARIABLE],
            precipitation_in=floats[PRECIPITATION_VARIABLE],
            temperature_f=floats[TEMPERATURE_VARIABLE],
            weather_code=_code_series(series[WEATHER_CODE_VARIABLE], hours),
            source_lat=_optional_float(source["lat"]),
            source_lon=_optional_float(source["lon"]),
            elevation_m=_optional_float(source["elevation_m"]),
        )


def _strict_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("expected an integer")
    return value


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TypeError("expected a number or null")
    return float(value)


def _float_series(value: object, hours: int) -> Series:
    if not isinstance(value, list) or len(value) != hours:
        raise TypeError("series length mismatch")
    return tuple(_optional_float(item) for item in value)


def _code_series(value: object, hours: int) -> CodeSeries:
    if not isinstance(value, list) or len(value) != hours:
        raise TypeError("series length mismatch")
    return tuple(None if item is None else _strict_int(item) for item in value)


class WeatherProvider(Protocol):
    """Supplies hourly forecasts for lattice points."""

    name: str
    model: str

    def fetch(
        self,
        points: Sequence[LatticePoint],
        window: HourWindow,
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """Return one forecast per requested point, each covering exactly ``window``.

        Hours the upstream cannot supply are ``None``; the call never silently drops a point.

        Raises:
            ProviderError: the upstream failed (see :mod:`haulcast.providers.errors`).
        """
        ...
