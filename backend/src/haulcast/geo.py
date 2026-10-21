"""The bounds of the globe and the one check of a coordinate that every adapter shares.

Four adapters and two parsers each carried their own copy of the latitude/longitude bounds, and the
two geocoding parsers an identical ``_bounded``. A copy drifts, so there is exactly one definition
here (review R2-38, pinned by ``tests/test_shared_definitions.py``).
"""

from typing import Final

MAX_LAT: Final = 90.0
"""Largest latitude magnitude in degrees."""
MAX_LON: Final = 180.0
"""Largest longitude magnitude in degrees."""


def bounded_coordinate(value: object, bound: float) -> float | None:
    """Return ``value`` as a float when it is a JSON number within ``+-bound``, else ``None``.

    The range check comes before the conversion on purpose: it also rejects NaN and infinity, and
    a huge JSON integer is refused instead of overflowing ``float``. A bool is not a coordinate.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if -bound <= value <= bound else None
