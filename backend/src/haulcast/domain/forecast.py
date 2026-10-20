"""Forecast values at a checkpoint ETA (DOMAIN-CONTRACT section 5)."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class WeatherSample:
    """The weather at one checkpoint at one instant; ``None`` means the value is missing.

    Risk inputs (wind, gust, rain, snow) are passed through faithfully, invalid ones included, so
    ``assess`` can flag them instead of silently treating them as calm.
    """

    valid_time: datetime
    wind_mph: float | None
    gust_mph: float | None
    rain_in_hr: float | None
    snow_in_hr: float | None
    temperature_f: float | None
    weather_code: int | None
