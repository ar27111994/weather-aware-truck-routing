"""Adapters between provider forecasts and the domain: hourly series and local time zones."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from tzfpy import get_tz

from haulcast.domain import HourlySeries
from haulcast.providers.weather.base import (
    GUST_VARIABLE,
    PRECIPITATION_VARIABLE,
    RAIN_VARIABLE,
    SHOWERS_VARIABLE,
    SNOWFALL_VARIABLE,
    TEMPERATURE_VARIABLE,
    WEATHER_CODE_VARIABLE,
    WIND_VARIABLE,
    HourlyForecast,
)

FALLBACK_ZONE = "UTC"
"""Zone reported where the time zone database has no answer (open water, polar caps)."""


def hourly_series(forecast: HourlyForecast) -> HourlySeries:
    """Return the domain's :class:`HourlySeries` for a provider's :class:`HourlyForecast`.

    Both name their variables after Open-Meteo's, so this only regroups the arrays (weather codes
    become floats, as the domain reads every variable as a number).
    """
    return HourlySeries(
        start=forecast.start,
        values={
            WIND_VARIABLE: forecast.wind_speed_mph,
            GUST_VARIABLE: forecast.wind_gust_mph,
            RAIN_VARIABLE: forecast.rain_in,
            SHOWERS_VARIABLE: forecast.showers_in,
            SNOWFALL_VARIABLE: forecast.snowfall_in,
            PRECIPITATION_VARIABLE: forecast.precipitation_in,
            TEMPERATURE_VARIABLE: forecast.temperature_f,
            WEATHER_CODE_VARIABLE: tuple(
                None if code is None else float(code) for code in forecast.weather_code
            ),
        },
    )


def local_zone(lat: float, lon: float, instant: datetime) -> tuple[str, int]:
    """Return the IANA zone at ``(lat, lon)`` and its UTC offset in seconds at ``instant``.

    The offset is that of ``instant`` (daylight saving included). Where the database knows no
    zone the answer is UTC with offset 0, never an error: a checkpoint is always displayable.
    """
    name = get_tz(lon, lat)
    try:
        zone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return FALLBACK_ZONE, 0
    offset = instant.astimezone(zone).utcoffset() or timedelta(0)
    return name, int(offset.total_seconds())
