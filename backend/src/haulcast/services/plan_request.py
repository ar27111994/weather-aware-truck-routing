"""The normalized plan request and its idempotency hash (API-CONTRACT: idempotency).

Callers (the API layer) have already validated ranges; this module makes equal requests *equal*.
Coordinates are rounded to four decimals (about 11 m), the departure is floored to the minute and
expressed in UTC, and the hash covers exactly what changes the answer: both places, the departure
minute, the load, the checkpoint interval and the scenario. Labels are display text and never
change a plan, so they stay out of the hash: the same trip typed two ways is one plan.
"""

import hashlib
import json
import unicodedata
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Final, Self

COORDINATE_DECIMALS: Final = 4
"""Decimals kept in request coordinates (about 11 m): the precision the hash is stable to."""

_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_MINUTE: Final = timedelta(minutes=1)
_TIMESTAMP_FORMAT: Final = "%Y-%m-%dT%H:%M:%SZ"


def clean_label(raw: str) -> str:
    """Strip control, format and other ``C*`` characters from a label, then trim it.

    Control characters (NUL, newlines), invisible format characters (zero-width spaces, the
    right-to-left override that can disguise text) and unassigned code points never belong in a
    place label that the UI renders as text; whitespace at the ends goes too.
    """
    return "".join(char for char in raw if not unicodedata.category(char).startswith("C")).strip()


def _rounded(value: float) -> float:
    """Round to the request precision; ``+ 0.0`` turns a negative zero into a positive one."""
    return round(value, COORDINATE_DECIMALS) + 0.0


@dataclass(frozen=True, slots=True)
class Place:
    """An origin or destination: coordinates and the label the traveller sees."""

    lat: float
    lon: float
    label: str

    def normalized(self) -> Self:
        """Return the place with coordinates at request precision."""
        return type(self)(lat=_rounded(self.lat), lon=_rounded(self.lon), label=self.label)

    def to_json(self) -> dict[str, object]:
        """The place as it appears in the request echo."""
        return {"lat": self.lat, "lon": self.lon, "label": self.label}


@dataclass(frozen=True, slots=True)
class PlanRequest:
    """A validated request for a plan; call :meth:`normalized` before hashing or storing it."""

    origin: Place
    destination: Place
    departure: datetime
    load_weight_lb: int
    sampling_interval_mi: int
    scenario: str | None

    def normalized(self) -> Self:
        """Return the request with rounded coordinates and a UTC departure floored to the minute.

        Raises:
            ValueError: ``departure`` is not timezone-aware.
        """
        if self.departure.utcoffset() is None:
            raise ValueError("the departure must be timezone-aware")
        return replace(
            self,
            origin=self.origin.normalized(),
            destination=self.destination.normalized(),
            departure=self.departure.astimezone(UTC).replace(second=0, microsecond=0),
        )

    @property
    def request_hash(self) -> str:
        """SHA-256 (hex) of the canonical form of everything that determines the plan."""
        canonical = {
            "origin": [self.origin.lat, self.origin.lon],
            "destination": [self.destination.lat, self.destination.lon],
            "departure_minute": (self.departure - _EPOCH) // _MINUTE,
            "load_weight_lb": self.load_weight_lb,
            "sampling_interval_mi": self.sampling_interval_mi,
            "scenario": self.scenario,
        }
        text = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def to_json(self) -> dict[str, object]:
        """The normalized request as echoed in the plan (``request``) and stored with it."""
        return {
            "origin": self.origin.to_json(),
            "destination": self.destination.to_json(),
            "departure_time": self.departure.strftime(_TIMESTAMP_FORMAT),
            "load_weight_lb": self.load_weight_lb,
            "sampling_interval_mi": self.sampling_interval_mi,
            "scenario": self.scenario,
        }
