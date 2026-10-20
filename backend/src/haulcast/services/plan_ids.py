"""Plan ids: ``pln_`` followed by a 26 character ULID (48-bit millisecond time + 80 random bits).

The id is the only secret of a share link (``/?plan=<id>``), so the random part comes from
:func:`secrets.token_bytes`. The leading timestamp makes ids sort by creation time, which keeps the
primary-key index append-mostly. Encoding is Crockford base32 as in the ULID specification.
"""

import re
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final

PLAN_ID_PREFIX: Final = "pln_"

PLAN_ID_PATTERN: Final = re.compile(r"pln_[0-7][0-9A-HJKMNP-TV-Z]{25}")
"""A well-formed plan id (the first character is at most 7: 128 bits fill 26 base32 digits)."""

_ALPHABET: Final = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_MILLISECOND: Final = timedelta(milliseconds=1)
_TIME_BITS: Final = 48
_ENTROPY_BYTES: Final = 10
_ENTROPY_BITS: Final = 8 * _ENTROPY_BYTES
_DIGITS: Final = 26
_BITS_PER_DIGIT: Final = 5
_DIGIT_MASK: Final = (1 << _BITS_PER_DIGIT) - 1


def new_plan_id(now: datetime, entropy: Callable[[int], bytes] = secrets.token_bytes) -> str:
    """Return a new plan id stamped with ``now`` (timezone-aware); ``entropy`` supplies 10 bytes.

    Raises:
        ValueError: ``now`` is outside the 48-bit millisecond range (1970 to the year 10889).
    """
    millis = (now - _EPOCH) // _MILLISECOND
    if not 0 <= millis < 1 << _TIME_BITS:
        raise ValueError("the timestamp must fit in 48 bits of milliseconds since 1970")
    value = (millis << _ENTROPY_BITS) | int.from_bytes(entropy(_ENTROPY_BYTES), "big")
    digits = [
        _ALPHABET[(value >> (_BITS_PER_DIGIT * position)) & _DIGIT_MASK]
        for position in reversed(range(_DIGITS))
    ]
    return PLAN_ID_PREFIX + "".join(digits)
