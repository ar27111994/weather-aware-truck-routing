"""Open-Meteo forecast adapter: hourly weather for lattice points, one form POST per chunk.

Protocol knowledge only (retries, timeouts, size caps and the HTTP failure mapping live in
:class:`~haulcast.providers.http.UpstreamClient`). Everything below was probed live on
2026-10-19/20 and is documented in the provider research (section Q3):

* ``POST application/x-www-form-urlencoded``: a GET URL dies at about 8 KB and a JSON body needs
  every value to be an array, so the form is the only comfortable way to send many locations.
* ``timezone=GMT`` with ``start_hour`` / ``end_hour`` (both ends inclusive) gives every location
  the same departure-anchored time axis; ``forecast_hours`` counts from the *current* hour and
  must not be used.
* One location answers with a JSON object, several with a JSON list in request order. Each item
  carries the grid cell actually used (``latitude``, ``longitude``, ``elevation``), the unit
  labels and one array per variable. Open-Meteo labels miles per hour ``mp/h``, and ``snowfall``
  is in inches under ``precipitation_unit=inch``.
* The units are validated strictly: any other label means the API changed under us, and a
  silently mis-scaled forecast would be far worse than a refused one.

Open-Meteo data is licensed CC BY 4.0: show :data:`OPENMETEO_ATTRIBUTION` (with a link to
https://open-meteo.com/) wherever the forecast is displayed.
"""

import hashlib
import math
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Final

from haulcast.providers.errors import ProviderResponseError
from haulcast.providers.http import UpstreamClient
from haulcast.providers.weather.base import (
    GUST_VARIABLE,
    PRECIPITATION_VARIABLE,
    RAIN_VARIABLE,
    SHOWERS_VARIABLE,
    SNOWFALL_VARIABLE,
    TEMPERATURE_VARIABLE,
    VARIABLES,
    WEATHER_CODE_VARIABLE,
    WIND_VARIABLE,
    HourlyForecast,
    HourWindow,
    LatticePoint,
)

OPENMETEO_ATTRIBUTION: Final = "Weather data by Open-Meteo.com (CC BY 4.0)"
"""The credit text the CC BY 4.0 licence asks to show, with a link, next to the data."""

DEFAULT_URL: Final = "https://api.open-meteo.com/v1/forecast"
DEFAULT_CHUNK_SIZE: Final = 250
"""Locations per request: a form body stays small and a failure costs one chunk, not a plan."""

MAX_LOCATIONS_PER_REQUEST: Final = 1000
"""Open-Meteo refuses more locations than this in one request (HTTP 400)."""

MAX_GRID_OFFSET_DEG: Final = 0.5
"""Farthest, per axis, the grid cell of a forecast may lie from the lattice point it answers for.

The coarsest model behind ``best_match`` has 0.25 degree cells, so the nearest cell is never much
more than 0.18 degrees away; half a degree leaves room for coastlines (cells are chosen on land)
and still catches an answer that belongs to another place.
"""

MODEL: Final = "best_match"
"""Open-Meteo's own blend of the best available models for the location and lead time."""

UNIT_PARAMETERS: Final = (
    ("wind_speed_unit", "mph"),
    ("precipitation_unit", "inch"),
    ("temperature_unit", "fahrenheit"),
)
"""The request parameters that fix the units of the numbers that come back (and get cached)."""

_TIME_PARAMETERS: Final = (("timeformat", "unixtime"), ("timezone", "GMT"))
_HASH_LENGTH: Final = 16
_SECONDS_PER_HOUR: Final = 3600
_TIME_KEY: Final = "time"

_EXPECTED_UNITS: Final[Mapping[str, str]] = {
    _TIME_KEY: "unixtime",
    WIND_VARIABLE: "mp/h",  # sic: this is how Open-Meteo labels miles per hour
    GUST_VARIABLE: "mp/h",
    RAIN_VARIABLE: "inch",
    SHOWERS_VARIABLE: "inch",
    SNOWFALL_VARIABLE: "inch",  # inches, not centimetres, because precipitation_unit=inch
    PRECIPITATION_VARIABLE: "inch",
    TEMPERATURE_VARIABLE: "\N{DEGREE SIGN}F",
    WEATHER_CODE_VARIABLE: "wmo code",
}

_NUMERIC_VARIABLES: Final = (
    WIND_VARIABLE,
    GUST_VARIABLE,
    RAIN_VARIABLE,
    SHOWERS_VARIABLE,
    SNOWFALL_VARIABLE,
    PRECIPITATION_VARIABLE,
    TEMPERATURE_VARIABLE,
)


def variable_set_hash(variables: Sequence[str], unit_parameters: Sequence[tuple[str, str]]) -> str:
    """Return a 16 hex digit fingerprint of the requested ``variables`` and ``unit_parameters``.

    A cached forecast is only comparable with a fresh one while both are unchanged, so the digest
    belongs in every cache key: adding a variable or switching a unit then misses the cache
    instead of serving numbers in the wrong shape.
    """
    text = "|".join(variables) + "|" + "|".join(f"{key}={value}" for key, value in unit_parameters)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:_HASH_LENGTH]


VARIABLE_SET_HASH: Final = variable_set_hash(VARIABLES, UNIT_PARAMETERS)
"""Fingerprint of what this adapter requests; part of the forecast cache keys."""


class _InvalidResponseError(ValueError):
    """The body does not have the documented shape; translated to ``ProviderResponseError``."""


class OpenMeteoProvider:
    """Hourly forecasts from Open-Meteo's ``best_match`` blend (a ``WeatherProvider``)."""

    name: str = "open-meteo"
    model: str = MODEL

    def __init__(
        self,
        client: UpstreamClient,
        *,
        url: str = DEFAULT_URL,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> None:
        """Bind the upstream ``client``; at most ``chunk_size`` locations go into one request.

        Raises:
            ValueError: ``chunk_size`` is not between 1 and :data:`MAX_LOCATIONS_PER_REQUEST`.
        """
        if not 1 <= chunk_size <= MAX_LOCATIONS_PER_REQUEST:
            raise ValueError(f"chunk_size must be between 1 and {MAX_LOCATIONS_PER_REQUEST}")
        self._client = client
        self._url = url
        self._chunk_size = chunk_size

    @property
    def max_points(self) -> int:
        """Locations per request: one chunk, which is also what one attempt is charged for."""
        return self._chunk_size

    def fetch(
        self,
        points: Sequence[LatticePoint],
        window: HourWindow,
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """Return one forecast per distinct point, each covering exactly ``window``.

        Points are de-duplicated (first-seen order is kept) and requested sequentially in chunks;
        no point means no request. Hours the response lacks are ``None``, hours it has beyond the
        window are ignored: rows are matched by timestamp, never by position.

        Raises:
            ProviderUnavailableError: timeout, connection failure or HTTP 5xx after the retries.
            ProviderRateLimitedError: HTTP 429 after the retry budget, or a wait we may not take.
            ProviderRejectedError: any other HTTP 4xx.
            ProviderResponseError: the body is empty, not JSON, in unexpected units, answers for
                none of the requested hours or for a grid cell far from the point, or is otherwise
                not what the documented response looks like.
        """
        unique = tuple(dict.fromkeys(points))
        forecasts: dict[LatticePoint, HourlyForecast] = {}
        for start in range(0, len(unique), self._chunk_size):
            forecasts.update(self._fetch_chunk(unique[start : start + self._chunk_size], window))
        return forecasts

    def _fetch_chunk(
        self,
        chunk: Sequence[LatticePoint],
        window: HourWindow,
    ) -> dict[LatticePoint, HourlyForecast]:
        payload = self._client.post_form(
            self._url, form=_request_form(chunk, window), idempotent=True, cost=len(chunk)
        )
        try:
            items = _items(payload, len(chunk))
            forecasts = {
                point: _forecast(point, item, window)
                for point, item in zip(chunk, items, strict=True)
            }
        except _InvalidResponseError as exc:
            raise ProviderResponseError(self._client.provider, str(exc)) from exc
        return forecasts


def _request_form(chunk: Sequence[LatticePoint], window: HourWindow) -> dict[str, str]:
    """Build the form body: lattice coordinates, the eight variables, units and the window."""
    return {
        "latitude": ",".join(f"{point.lat:.1f}" for point in chunk),
        "longitude": ",".join(f"{point.lon:.1f}" for point in chunk),
        "hourly": ",".join(VARIABLES),
        **dict(UNIT_PARAMETERS),
        **dict(_TIME_PARAMETERS),
        "start_hour": _hour_stamp(window.start),
        "end_hour": _hour_stamp(window.end),
    }


def _hour_stamp(moment: datetime) -> str:
    """Format a UTC hour the way ``start_hour`` / ``end_hour`` expect it (``timezone=GMT``)."""
    return moment.strftime("%Y-%m-%dT%H:%M")


def _items(payload: object, expected: int) -> Sequence[object]:
    """Normalise the single-object and list shapes to a list of ``expected`` location entries."""
    if isinstance(payload, dict):
        items: Sequence[object] = [payload]
    elif isinstance(payload, list):
        items = payload
    else:
        raise _InvalidResponseError("response is neither an object nor a list")
    if len(items) != expected:
        raise _InvalidResponseError(f"expected {expected} locations, got {len(items)}")
    return items


def _forecast(point: LatticePoint, item: object, window: HourWindow) -> HourlyForecast:
    """Validate one location entry and align its hours to ``window`` by timestamp."""
    record = _mapping(item, "location entry is not an object")
    _check_units(record.get("hourly_units"))
    hourly = _mapping(record.get("hourly"), "hourly is missing or not an object")
    times = _list(hourly.get(_TIME_KEY), _TIME_KEY)
    positions = _positions(times, window)
    source_lat = _optional_number(record.get("latitude"), "latitude")
    source_lon = _optional_number(record.get("longitude"), "longitude")
    _check_grid_cell(point, source_lat, source_lon)
    numeric = {
        name: _align(
            [_optional_number(value, name) for value in _column(hourly, name, len(times))],
            positions,
        )
        for name in _NUMERIC_VARIABLES
    }
    codes = _align(
        [
            _optional_code(value, WEATHER_CODE_VARIABLE)
            for value in _column(hourly, WEATHER_CODE_VARIABLE, len(times))
        ],
        positions,
    )
    return HourlyForecast(
        point=point,
        model=MODEL,
        start=window.start,
        wind_speed_mph=numeric[WIND_VARIABLE],
        wind_gust_mph=numeric[GUST_VARIABLE],
        rain_in=numeric[RAIN_VARIABLE],
        showers_in=numeric[SHOWERS_VARIABLE],
        snowfall_in=numeric[SNOWFALL_VARIABLE],
        precipitation_in=numeric[PRECIPITATION_VARIABLE],
        temperature_f=numeric[TEMPERATURE_VARIABLE],
        weather_code=codes,
        source_lat=source_lat,
        source_lon=source_lon,
        elevation_m=_optional_number(record.get("elevation"), "elevation"),
    )


def _check_grid_cell(point: LatticePoint, lat: float | None, lon: float | None) -> None:
    """Refuse a forecast whose grid cell is far from ``point`` (it belongs to another place)."""
    for expected, actual in ((point.lat, lat), (point.lon, lon)):
        if actual is not None and abs(actual - expected) > MAX_GRID_OFFSET_DEG:
            raise _InvalidResponseError("the grid cell is far from the requested point")


def _check_units(units: object) -> None:
    """Refuse anything but the exact unit labels our request produces (never guess units)."""
    if units == _EXPECTED_UNITS:
        return
    actual = units if isinstance(units, dict) else {}
    wrong = [name for name, label in _EXPECTED_UNITS.items() if actual.get(name) != label]
    detail = f" for {', '.join(wrong)}" if wrong else ""
    raise _InvalidResponseError(f"unexpected units{detail}")


def _mapping(value: object, message: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise _InvalidResponseError(message)
    return value


def _list(value: object, name: str) -> Sequence[object]:
    if not isinstance(value, list):
        raise _InvalidResponseError(f"{name} is missing or not a list")
    return value


def _column(hourly: Mapping[str, object], name: str, length: int) -> Sequence[object]:
    """Return the array of ``name`` after checking it has one value per timestamp."""
    values = _list(hourly.get(name), name)
    if len(values) != length:
        raise _InvalidResponseError(f"{name} has {len(values)} values for {length} timestamps")
    return values


def _positions(times: Sequence[object], window: HourWindow) -> list[int | None]:
    """Map every hour of ``window`` to its index in the response, ``None`` if it has no row.

    Some missing hours are gaps in the data and stay ``None``; a response with *no* row for the
    window (its time axis lies elsewhere) is refused.
    """
    index: dict[int, int] = {}
    for position, stamp in enumerate(times):
        if isinstance(stamp, bool) or not isinstance(stamp, int):
            raise _InvalidResponseError(f"{_TIME_KEY} holds a non-integer value")
        if stamp in index:
            raise _InvalidResponseError(f"{_TIME_KEY} repeats a timestamp")
        index[stamp] = position
    first = int(window.start.timestamp())
    positions = [index.get(first + hour * _SECONDS_PER_HOUR) for hour in range(window.hours)]
    if all(position is None for position in positions):
        # A forecast of nothing but gaps would be cached for an hour as if it were an answer.
        raise _InvalidResponseError("response has no row for any requested hour")
    return positions


def _align[T](values: Sequence[T | None], positions: Sequence[int | None]) -> tuple[T | None, ...]:
    return tuple(None if position is None else values[position] for position in positions)


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _InvalidResponseError(f"{name} holds a non-numeric value")
    try:
        number = float(value)
    except OverflowError as exc:
        raise _InvalidResponseError(f"{name} holds a non-finite value") from exc
    if not math.isfinite(number):
        raise _InvalidResponseError(f"{name} holds a non-finite value")
    return number


def _optional_number(value: object, name: str) -> float | None:
    return None if value is None else _number(value, name)


def _optional_code(value: object, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _InvalidResponseError(f"{name} holds a non-integer value")
    return value
