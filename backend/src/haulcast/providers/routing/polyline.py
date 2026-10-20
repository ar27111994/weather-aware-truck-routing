"""Decoder for Google's encoded polyline format, as used by Valhalla and OSRM (precision 6).

Both routing upstreams ship route shapes as an encoded polyline: each coordinate is a pair of
signed deltas, zig-zag encoded and written as 5-bit chunks offset into printable ASCII. The decoder
is strict: truncated or corrupt input raises :class:`ValueError` instead of yielding a plausible
but wrong shape, and the adapters turn that into a ``ProviderResponseError``.
"""

from collections.abc import Iterator
from typing import Final

_ASCII_OFFSET: Final = 63
_MAX_CHUNK: Final = 63
_CONTINUATION_BIT: Final = 0x20
_CHUNK_MASK: Final = 0x1F
_CHUNK_BITS: Final = 5
_MAX_CHUNKS_PER_VALUE: Final = 7
"""Seven 5-bit chunks hold any zig-zag encoded 32-bit value; longer runs are corrupt input."""


def _decode_values(encoded: str) -> Iterator[int]:
    """Yield the signed integer deltas written in ``encoded``, in order."""
    value = shift = chunks = 0
    for char in encoded:
        chunk = ord(char) - _ASCII_OFFSET
        if not 0 <= chunk <= _MAX_CHUNK:
            raise ValueError(f"invalid polyline character {char!r}")
        chunks += 1
        if chunks > _MAX_CHUNKS_PER_VALUE:
            raise ValueError("polyline value is too long")
        value |= (chunk & _CHUNK_MASK) << shift
        shift += _CHUNK_BITS
        if chunk < _CONTINUATION_BIT:
            yield ~(value >> 1) if value & 1 else value >> 1
            value = shift = chunks = 0
    if chunks:
        raise ValueError("polyline ends in the middle of a value")


def decode_polyline(encoded: str, precision: int) -> tuple[tuple[float, float], ...]:
    """Decode ``encoded`` into ``(lat, lon)`` pairs in degrees.

    ``precision`` is the number of decimal digits the encoder kept: 6 for Valhalla and for OSRM
    with ``geometries=polyline6``, 5 for classic Google polylines. Note the order: polylines carry
    latitude first, whereas the rest of the routing package uses ``(lon, lat)``.

    Raises:
        ValueError: ``precision`` is negative, or ``encoded`` contains a character outside the
            polyline alphabet, ends in the middle of a value, or ends after a latitude.
    """
    if precision < 0:
        raise ValueError("precision must not be negative")
    scale = 10**precision
    values = _decode_values(encoded)
    lat = lon = 0
    points: list[tuple[float, float]] = []
    for delta_lat in values:
        delta_lon = next(values, None)
        if delta_lon is None:
            raise ValueError("polyline ends after a latitude without its longitude")
        lat += delta_lat
        lon += delta_lon
        points.append((lat / scale, lon / scale))
    return tuple(points)
