"""Exact quantization to integer steps (DOMAIN-CONTRACT D-02): ``round_half_even(value * scale)``.

Classification and ranking compare quantized integers so that float noise never decides. The
product ``value * scale`` has to be rounded exactly, though. In binary floating point a value a
hair below a half-step multiplies out to exactly ``.5`` (``54.949999999999996 * 10 == 549.5``) and
then rounds to the even neighbour, the wrong way: the exact 54.9 mph (Severe) came out as 55.0 mph
(No Travel, LR-1).

A value is therefore read the way it was written, as its shortest decimal form (what ``repr``
prints, and what a JSON provider sent), and rounded half to even exactly. Exact arithmetic is only
needed near a tie, so the float product decides everywhere it provably cannot be wrong.
"""

import math
from fractions import Fraction
from typing import Final

_FLOAT_PRODUCT_LIMIT: Final = float(2**40)
"""Largest scaled magnitude whose float product is trusted (far above any physical value)."""

_TRUSTED_DISTANCE: Final = 0.5 - 2.0**-10
"""The farthest a trusted float product may sit from a whole number (see ``quantize_exactly``)."""


def quantize_exactly(value: float, scale: int) -> int:
    """Return ``value`` as a whole number of ``1 / scale`` steps, rounding half to even exactly.

    The float product ``value * scale`` differs from the exact product of the value's decimal form
    by at most 2**-52 of its size: the decimal form is within half a float step of the value, and
    the multiplication rounds once more. Below 2**40 that is under 2**-12, so a product farther
    than 2**-10 from a half-step (four times that error) rounds the same way as the exact one and
    decides alone. Only a product within 2**-10 of a tie, or at least 2**40, is rounded exactly.

    Raises:
        ValueError: ``value`` is NaN or infinite; callers screen provider data first.
    """
    scaled = value * scale
    if abs(scaled) < _FLOAT_PRODUCT_LIMIT:
        nearest = round(scaled)
        if abs(scaled - nearest) < _TRUSTED_DISTANCE:
            return nearest
    if not math.isfinite(value):
        raise ValueError(f"cannot quantize {value!r}: it is not a finite number")
    return round(Fraction(repr(value)) * scale)
