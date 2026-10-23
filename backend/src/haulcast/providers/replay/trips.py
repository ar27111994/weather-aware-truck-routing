"""The recorded trips, and the gazetteer of the cities they start and end in.

Each trip names the recorded Valhalla and OSRM answers for it. The positions are the exact request
coordinates of those recordings (``routing/INDEX.json`` holds them), which is what replay routing
matches a request against. The gazetteer is built from the same endpoints, so every place a
recorded trip can start or end at can also be typed into the search box.
"""

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Trip:
    """A recorded trip: its endpoints and the recorded provider answers for it."""

    name: str
    origin: tuple[float, float]
    """``(lat, lon)`` of the recorded request."""
    destination: tuple[float, float]
    """``(lat, lon)`` of the recorded request."""
    origin_label: str
    """``name, state, country``."""
    destination_label: str
    """``name, state, country``."""
    valhalla: str
    """File name of the recorded Valhalla truck answer, below ``routing/``."""
    osrm: str
    """File name of the recorded OSRM answer, below ``routing/``."""


SLC_DENVER = Trip(
    "slc-den",
    (40.7608, -111.891),
    (39.7392, -104.9903),
    "Salt Lake City, Utah, United States",
    "Denver, Colorado, United States",
    "valhalla-slc-den-truck-alt2.json",
    "osrm-slc-den-alt3.json",
)
CHICAGO_DENVER = Trip(
    "chi-den",
    (41.8781, -87.6298),
    (39.7392, -104.9903),
    "Chicago, Illinois, United States",
    "Denver, Colorado, United States",
    "valhalla-chi-den-truck-alt2.json",
    "osrm-chi-den-alt3.json",
)
NEWARK_JERSEY_CITY = Trip(
    "newark-jc",
    (40.7357, -74.1724),
    (40.7178, -74.0431),
    "Newark, New Jersey, United States",
    "Jersey City, New Jersey, United States",
    "valhalla-newark-jc-truck-alt2.json",
    "osrm-newark-jc-alt3.json",
)
LA_PHOENIX = Trip(
    "la-phx",
    (34.0522, -118.2437),
    (33.4484, -112.074),
    "Los Angeles, California, United States",
    "Phoenix, Arizona, United States",
    "valhalla-la-phx-truck-alt2.json",
    "osrm-la-phx-alt3.json",
)
TRIPS = (SLC_DENVER, CHICAGO_DENVER, NEWARK_JERSEY_CITY, LA_PHOENIX)
"""Every recorded trip: a request for any other pair of places has no recorded route."""

_LABEL_PARTS = 3


@dataclass(frozen=True, slots=True)
class Place:
    """A city of the gazetteer."""

    name: str
    state: str
    country: str
    lat: float
    lon: float

    @property
    def label(self) -> str:
        """``name, state, country``: the label the trips carry for this place."""
        return f"{self.name}, {self.state}, {self.country}"


def gazetteer(trips: Sequence[Trip] = TRIPS) -> tuple[Place, ...]:
    """Return the distinct endpoints of ``trips`` as places, in order of first appearance.

    Raises:
        ValueError: an endpoint label is not ``name, state, country``.
    """
    places: dict[str, Place] = {}
    for trip in trips:
        endpoints = (
            (trip.origin_label, trip.origin),
            (trip.destination_label, trip.destination),
        )
        for label, (lat, lon) in endpoints:
            if label not in places:
                places[label] = _place(label, lat, lon)
    return tuple(places.values())


def _place(label: str, lat: float, lon: float) -> Place:
    parts = label.split(", ")
    if len(parts) != _LABEL_PARTS:
        raise ValueError(f"the label {label!r} is not 'name, state, country'")
    name, state, country = parts
    return Place(name, state, country, lat, lon)
