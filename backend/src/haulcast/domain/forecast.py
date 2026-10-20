"""Forecast values at a checkpoint ETA (DOMAIN-CONTRACT section 5).

Hourly series are stamped at UTC hour starts ``H``. How a variable's value at an instant ``t`` is
read depends on what its samples mean, which is DATA (``VARIABLE_SPECS``), verified against
Open-Meteo by the research card:

* ``INSTANT`` (``wind_speed_10m``, ``temperature_2m``): linear interpolation between the samples
  at ``floor_hour(t)`` and ``ceil_hour(t)``; the exact sample when ``t`` is on the hour.
* ``NEAREST`` (``weather_code``, a categorical instant): the sample at the nearest hour, never an
  interpolated code; exactly half past resolves to the earlier hour.
* ``PRECEDING_HOUR`` (``rain``, ``showers``, ``snowfall``, ``precipitation`` sums and the
  ``wind_gusts_10m`` maximum): the sample stamped ``ceil_hour(t)``, which describes the interval
  ``(H - 1h, H]`` containing ``t``; ``t`` exactly on ``H`` reads sample ``H``.

A needed sample that is outside the series or null makes the value UNKNOWN (``None``). An invalid
sample (non-finite, or negative for a non-negative variable) becomes ``NaN`` so it can never be
interpolated or summed into a plausible number: ``assess`` reports it. Display-only values
(temperature, weather code) that are invalid are simply unknown.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from haulcast.domain.errors import InvalidForecastError, NaiveDatetimeError

_HOUR: Final = timedelta(hours=1)
_HALF_HOUR: Final = timedelta(minutes=30)
_ZERO: Final = timedelta(0)


class Semantics(StrEnum):
    """What one hourly sample of a variable describes (DOMAIN-CONTRACT section 5)."""

    INSTANT = "instant"
    NEAREST = "nearest"
    PRECEDING_HOUR = "preceding_hour"


@dataclass(frozen=True, slots=True)
class VariableSpec:
    """How to read one forecast variable: its semantics and whether negatives are physical."""

    semantics: Semantics
    signed: bool = False


VARIABLE_SPECS: Final[Mapping[str, VariableSpec]] = MappingProxyType(
    {
        "wind_speed_10m": VariableSpec(Semantics.INSTANT),
        "temperature_2m": VariableSpec(Semantics.INSTANT, signed=True),
        "weather_code": VariableSpec(Semantics.NEAREST),
        "rain": VariableSpec(Semantics.PRECEDING_HOUR),
        "showers": VariableSpec(Semantics.PRECEDING_HOUR),
        "snowfall": VariableSpec(Semantics.PRECEDING_HOUR),
        "precipitation": VariableSpec(Semantics.PRECEDING_HOUR),
        "wind_gusts_10m": VariableSpec(Semantics.PRECEDING_HOUR),
    }
)
"""Open-Meteo variable name -> how its samples are read. Flip an entry to change the rule."""


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


@dataclass(frozen=True, slots=True)
class HourlySeries:
    """Contiguous hourly samples starting at the UTC hour ``start`` (``None`` = missing sample).

    ``values`` maps an Open-Meteo variable name to its samples, one per hour, all equally long.
    Units are the adapter's job: mph, inches (per hour for the sums), degrees Fahrenheit.
    """

    start: datetime
    values: Mapping[str, tuple[float | None, ...]]

    def __post_init__(self) -> None:
        """Reject a start that is not a UTC hour, and ragged or empty arrays."""
        offset = self.start.utcoffset()
        if offset is None:
            raise NaiveDatetimeError("the series start must be timezone-aware")
        if offset != _ZERO:
            raise InvalidForecastError("the series start must be in UTC")
        if (self.start.minute, self.start.second, self.start.microsecond) != (0, 0, 0):
            raise InvalidForecastError("the series start must be on the hour")
        lengths = {len(samples) for samples in self.values.values()}
        if len(lengths) != 1 or 0 in lengths:
            raise InvalidForecastError("series arrays must be non-empty and equally long")

    @property
    def hours(self) -> int:
        """Number of hourly samples per variable."""
        return len(next(iter(self.values.values())))

    @property
    def end(self) -> datetime:
        """The stamp of the last sample."""
        return self.start + (self.hours - 1) * _HOUR


def sample_at(
    series: HourlySeries, eta: datetime, variables: Mapping[str, VariableSpec] = VARIABLE_SPECS
) -> WeatherSample:
    """Read the weather at ``eta`` from ``series`` (D-05), as an absolute UTC instant.

    Args:
        series: The hourly forecast at the checkpoint's location.
        eta: The truck's estimated arrival, in any time zone (DST is irrelevant in UTC).
        variables: How each variable is read; defaults to the verified Open-Meteo table.

    Raises:
        NaiveDatetimeError: ``eta`` has no time zone.
    """
    if eta.utcoffset() is None:
        raise NaiveDatetimeError("the ETA must be timezone-aware")
    valid_time = eta.astimezone(UTC)
    index, remainder = divmod(valid_time - series.start, _HOUR)

    def read(name: str) -> float | None:
        spec = variables[name]
        samples = series.values.get(name)
        if samples is None:
            return None
        if spec.semantics is Semantics.PRECEDING_HOUR:
            return _sample(samples, index if remainder == _ZERO else index + 1, spec)
        if spec.semantics is Semantics.NEAREST:
            return _sample(samples, index if remainder <= _HALF_HOUR else index + 1, spec)
        if remainder == _ZERO:
            return _sample(samples, index, spec)
        before, after = _sample(samples, index, spec), _sample(samples, index + 1, spec)
        if before is None or after is None:
            return None
        return before + (after - before) * (remainder / _HOUR)

    rain_parts = [part for part in (read("rain"), read("showers")) if part is not None]
    temperature, code = read("temperature_2m"), read("weather_code")
    return WeatherSample(
        valid_time=valid_time,
        wind_mph=read("wind_speed_10m"),
        gust_mph=read("wind_gusts_10m"),
        rain_in_hr=math.fsum(rain_parts) if rain_parts else None,
        snow_in_hr=read("snowfall"),
        temperature_f=temperature
        if temperature is not None and math.isfinite(temperature)
        else None,
        weather_code=int(code) if code is not None and code.is_integer() else None,
    )


def _sample(samples: tuple[float | None, ...], index: int, spec: VariableSpec) -> float | None:
    """Return one sample: ``None`` if absent, ``NaN`` if invalid for the variable."""
    if not 0 <= index < len(samples):
        return None
    value = samples[index]
    if value is None:
        return None
    if not math.isfinite(value) or (value < 0 and not spec.signed):
        return math.nan
    return float(value)
