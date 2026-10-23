"""The routing replay: recorded Valhalla and OSRM answers, picked by the trip a request names.

A request is matched to a recorded trip by its two positions, the way the adapters build them:
Valhalla's JSON body holds ``locations``, OSRM's URL ends in ``lon,lat;lon,lat``. A real router
snaps the point it is given to the nearest road, so a position within :data:`SNAP_RADIUS_MI` of a
trip's recorded endpoint counts as that endpoint: a city typed into the search box (whose centre a
geocoder places a few hundred metres from the recorded request) still finds its trip. Any other pair
of places is unrecorded, and gets the provider's own recorded "no route" answer.
"""

import json
from collections.abc import Sequence
from typing import Final

import httpx

from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.errors import ReplayRequestError
from haulcast.providers.replay.trips import TRIPS, Trip
from haulcast.providers.routing.base import Coordinate
from haulcast.providers.routing.geometry import haversine_mi

SNAP_RADIUS_MI: Final = 1.25
"""About two kilometres: more than the spread between geocoders' city centres (the recorded
Denver and Chicago positions lie 0.3 to 0.5 km from the recorded trips), far below the distance
between two cities of the table (Newark and Jersey City are 7 miles apart)."""

VALHALLA_NO_PATH: Final = "valhalla-error-no-path.json"
"""Valhalla's recorded answer when no route connects two places (HTTP 400, error 442)."""

OSRM_NO_ROUTE: Final = "osrm-error-no-route.json"
"""OSRM's recorded answer when no route connects two places (HTTP 200, code ``NoRoute``)."""

_JSON: Final = {"Content-Type": "application/json"}
_NO_PATH_STATUS: Final = 400


def _valhalla_endpoints(request: httpx.Request) -> tuple[Coordinate, Coordinate]:
    """Return the first two ``locations`` of a Valhalla request body as ``(lon, lat)`` pairs."""
    try:
        first, second = json.loads(request.content)["locations"][:2]
        return (float(first["lon"]), float(first["lat"])), (
            float(second["lon"]),
            float(second["lat"]),
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise ReplayRequestError(
            "a valhalla request must carry two locations with a lat and a lon"
        ) from exc


def _osrm_endpoints(request: httpx.Request) -> tuple[Coordinate, Coordinate]:
    """Return the ``lon,lat;lon,lat`` pair that ends an OSRM request path."""
    try:
        first, second = (
            tuple(float(part) for part in waypoint.split(","))
            for waypoint in request.url.path.rsplit("/", 1)[-1].split(";")
        )
        (lon_a, lat_a), (lon_b, lat_b) = first, second
    except ValueError as exc:
        raise ReplayRequestError(
            "an osrm request must end in lon,lat;lon,lat (two waypoints)"
        ) from exc
    return (lon_a, lat_a), (lon_b, lat_b)


def _snaps_to(requested: Coordinate, endpoint: tuple[float, float]) -> bool:
    """Whether ``requested`` lies within the snap radius of a trip endpoint given as (lat, lon)."""
    lat, lon = endpoint
    return haversine_mi(requested, (lon, lat)) <= SNAP_RADIUS_MI


class RoutingReplay:
    """Answers Valhalla and OSRM requests with the recorded answer of the trip they name."""

    def __init__(self, catalog: ReplayCatalog, trips: Sequence[Trip] = TRIPS) -> None:
        """Serve the recordings of ``trips`` from ``catalog``."""
        self._catalog = catalog
        self._trips = tuple(trips)

    def valhalla(self, request: httpx.Request) -> httpx.Response:
        """Answer a Valhalla ``/route`` request: the recorded truck routes or the recorded 400."""
        trip = self._trip_between(*_valhalla_endpoints(request))
        if trip is None:
            return self._answer(VALHALLA_NO_PATH, status=_NO_PATH_STATUS)
        return self._answer(trip.valhalla)

    def osrm(self, request: httpx.Request) -> httpx.Response:
        """Answer an OSRM ``route`` request: the recorded car routes or the recorded NoRoute."""
        trip = self._trip_between(*_osrm_endpoints(request))
        if trip is None:
            return self._answer(OSRM_NO_ROUTE)
        return self._answer(trip.osrm)

    def _trip_between(self, origin: Coordinate, destination: Coordinate) -> Trip | None:
        """Return the recorded trip from ``origin`` to ``destination``, or ``None``."""
        for trip in self._trips:
            if _snaps_to(origin, trip.origin) and _snaps_to(destination, trip.destination):
                return trip
        return None

    def _answer(self, name: str, *, status: int = 200) -> httpx.Response:
        """The recorded file ``name`` with ``status``, byte for byte."""
        return httpx.Response(
            status, content=self._catalog.read_bytes("routing", name), headers=_JSON
        )
