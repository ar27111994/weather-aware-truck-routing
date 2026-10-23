"""The geocoding replay: recorded queries verbatim, a gazetteer for the cities of the trips.

A query that was recorded gets its recording, byte for byte, whatever parameters the request carries
(the recordings were made with parameter combinations the adapters may not send): requests match by
the normalised, case-folded query, never by the full URL. Any other query of two or more characters
is answered from the gazetteer, built from the endpoints of the recorded trips, by case-insensitive
prefix of a city's name or label, in the wire format of the provider that is asked, so the real
adapter parses it like a recording. Everything else gets the provider's empty answer.
"""

from collections.abc import Mapping, Sequence
from typing import Final

import httpx

from haulcast.providers.geocoding.text import cache_key
from haulcast.providers.replay.catalog import ReplayCatalog
from haulcast.providers.replay.trips import Place, gazetteer

OPEN_METEO_RECORDINGS: Final[Mapping[str, str]] = {
    "denver": "omgeo-denver.json",
    "denver, co": "omgeo-denver-co.json",
    "salt lake": "omgeo-salt-lake.json",
    "newark": "omgeo-newark.json",
    "springfield": "omgeo-springfield.json",
    "den": "omgeo-partial-den.json",
    "united states": "omgeo-united-states.json",
    "d": "omgeo-one-char.json",
    "1600 pennsylvania ave nw": "omgeo-address.json",
}
"""Recorded Open-Meteo geocoding queries (normalised, case-folded) and the file of each answer."""

PHOTON_RECORDINGS: Final[Mapping[str, str]] = {
    "denver": "photon-denver.json",
    "chicago, il": "photon-chicago-il.json",
    "den": "photon-partial-den.json",
    "denv": "photon-partial-denv-us-bias.json",
    "springfield": "photon-springfield-bias-mo.json",
    "1600 pennsylvania ave nw washington": "photon-address.json",
}
"""Recorded Photon queries and the file of each answer.

Springfield was recorded twice. The adapter always sends a bias towards the United States, so the
recording made with a bias is the one served; ``photon-springfield-nobias.json`` is never used.
"""

OPEN_METEO_EMPTY: Final = "omgeo-one-char.json"
"""Open-Meteo's recorded empty answer: HTTP 200 and an object without ``results``."""

OPEN_METEO_NO_NAME: Final = "omgeo-no-name.json"
"""Open-Meteo's recorded answer to a request without ``name`` (HTTP 400)."""

PHOTON_NO_QUERY: Final = "photon-no-q.json"
"""Photon's recorded answer to a request without ``q`` (HTTP 400)."""

MIN_QUERY_CHARS: Final = 2
"""Shortest query the gazetteer answers (the API refuses shorter ones before they get here)."""

COUNTRY_CODE: Final = "US"
"""Every place of the gazetteer is in the United States (``trips`` tests that)."""

SYNTHETIC_ID_BASE: Final = 900_000
"""Gazetteer ids start here: below any real GeoNames or OSM id of these places, above none."""

_GENERATION_TIME_MS: Final = 0.5
_BAD_REQUEST: Final = 400
_JSON: Final = {"Content-Type": "application/json"}


def _open_meteo_entry(place: Place, place_id: int) -> dict[str, object]:
    return {
        "id": place_id,
        "name": place.name,
        "latitude": place.lat,
        "longitude": place.lon,
        "feature_code": "PPL",
        "country_code": COUNTRY_CODE,
        "country": place.country,
        "admin1": place.state,
    }


def _photon_feature(place: Place, place_id: int) -> dict[str, object]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [place.lon, place.lat]},
        "properties": {
            "osm_type": "R",
            "osm_id": place_id,
            "osm_key": "place",
            "osm_value": "city",
            "type": "city",
            "name": place.name,
            "state": place.state,
            "country": place.country,
            "countrycode": COUNTRY_CODE,
        },
    }


class GeocodingReplay:
    """Answers Open-Meteo and Photon geocoding requests from recordings and the gazetteer."""

    def __init__(self, catalog: ReplayCatalog, places: Sequence[Place] | None = None) -> None:
        """Serve recordings from ``catalog`` and the cities ``places`` (default: the trips')."""
        self._catalog = catalog
        self._places = gazetteer() if places is None else tuple(places)

    def open_meteo(self, request: httpx.Request) -> httpx.Response:
        """Answer an Open-Meteo geocoding search (``name``): a recording, or the gazetteer."""
        name = request.url.params.get("name")
        if name is None:
            return self._file(OPEN_METEO_NO_NAME, status=_BAD_REQUEST)
        key = cache_key(name)
        for recorded_query, file in OPEN_METEO_RECORDINGS.items():
            if recorded_query == key:
                return self._file(file)
        matches = self._matches(key)
        if not matches:
            return self._file(OPEN_METEO_EMPTY)
        entries = [_open_meteo_entry(place, place_id) for place_id, place in matches]
        return httpx.Response(
            200, json={"results": entries, "generationtime_ms": _GENERATION_TIME_MS}
        )

    def photon(self, request: httpx.Request) -> httpx.Response:
        """Answer a Photon search (``q``) like the service did, or from the gazetteer."""
        query = request.url.params.get("q")
        if query is None:
            return self._file(PHOTON_NO_QUERY, status=_BAD_REQUEST)
        key = cache_key(query)
        for recorded_query, file in PHOTON_RECORDINGS.items():
            if recorded_query == key:
                return self._file(file)
        features = [_photon_feature(place, place_id) for place_id, place in self._matches(key)]
        return httpx.Response(200, json={"type": "FeatureCollection", "features": features})

    def _matches(self, key: str) -> list[tuple[int, Place]]:
        """The gazetteer places whose name or label starts with ``key``, with their ids."""
        if len(key) < MIN_QUERY_CHARS:
            return []
        return [
            (SYNTHETIC_ID_BASE + index, place)
            for index, place in enumerate(self._places)
            if place.name.casefold().startswith(key) or place.label.casefold().startswith(key)
        ]

    def _file(self, name: str, *, status: int = 200) -> httpx.Response:
        """The recorded file ``name`` with ``status``, byte for byte."""
        return httpx.Response(
            status, content=self._catalog.read_bytes("geocoding", name), headers=_JSON
        )
