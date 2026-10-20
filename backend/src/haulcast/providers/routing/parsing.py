"""Validating accessors for the JSON documents of the routing upstreams.

Both routing adapters read documents they do not control. Every accessor raises a
:class:`~haulcast.providers.errors.ProviderResponseError` that names the upstream and the offending
*part* (never the offending value: upstream text must not reach logs unbounded), so a malformed or
inconsistent answer is refused as a whole instead of being repaired into plausible-looking numbers.
"""

import math
from collections.abc import Mapping
from typing import Final

from haulcast.providers.errors import ProviderResponseError
from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.polyline import decode_polyline

_MIN_POINTS: Final = 2
"""A route needs at least a start and an end."""
_MAX_LAT: Final = 90.0
_MAX_LON: Final = 180.0


class Parser:
    """Strict accessors for one upstream's documents; failures name ``provider``."""

    def __init__(self, provider: str) -> None:
        """Name the upstream that errors are attributed to."""
        self.provider = provider

    def error(self, message: str) -> ProviderResponseError:
        """Return the error to raise for an unusable document."""
        return ProviderResponseError(self.provider, message)

    def mapping(self, value: object, what: str) -> Mapping[str, object]:
        """Return ``value`` if it is a JSON object."""
        if not isinstance(value, dict):
            raise self.error(f"{what} is not an object")
        return value

    def sequence(self, value: object, what: str) -> list[object]:
        """Return ``value`` if it is a JSON array."""
        if not isinstance(value, list):
            raise self.error(f"{what} is not a list")
        return value

    def number(self, value: object, what: str) -> float:
        """Return ``value`` as a float if it is a finite, non-negative JSON number (not a bool)."""
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
            or value < 0
        ):
            raise self.error(f"{what} is not a non-negative number")
        return float(value)

    def index(self, value: object, what: str, last: int) -> int:
        """Return ``value`` if it is an integer index in ``0..last`` (not a bool)."""
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= last:
            raise self.error(f"{what} is not a valid shape index")
        return value

    def polyline(self, value: object, what: str, precision: int) -> tuple[Coordinate, ...]:
        """Decode an encoded polyline into validated ``(lon, lat)`` coordinates.

        Raises:
            ProviderResponseError: not text, not a valid polyline, fewer than two points, or a
                point outside the valid latitude/longitude range.
        """
        if not isinstance(value, str):
            raise self.error(f"{what} is not a string")
        try:
            points = decode_polyline(value, precision)
        except ValueError as exc:
            raise self.error(f"{what} is not a valid polyline") from exc
        if len(points) < _MIN_POINTS:
            raise self.error(f"{what} has fewer than two points")
        if any(abs(lat) > _MAX_LAT or abs(lon) > _MAX_LON for lat, lon in points):
            raise self.error(f"{what} leaves the valid coordinate range")
        return tuple((lon, lat) for lat, lon in points)
