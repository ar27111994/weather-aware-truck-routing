"""Photon geocoding adapter: GeoJSON features from photon.komoot.io to :class:`GeocodeCandidate`.

Photon is key-free OpenStreetMap geocoding that tolerates search-as-you-type. This module holds only
the protocol knowledge (request parameters, response shape, field mapping). Retries, timeouts, size
caps and the mapping of HTTP failures onto :mod:`haulcast.providers.errors` live in
:class:`~haulcast.providers.http.UpstreamClient`, whose errors propagate unchanged.

A feature that cannot be turned into a trustworthy candidate (no usable id, name or point) is
skipped: one odd result must not hide the good ones. A document whose envelope is not a GeoJSON
feature collection is a :class:`~haulcast.providers.errors.ProviderResponseError`.
"""

from collections.abc import Mapping
from typing import Final

from haulcast.providers.errors import ProviderResponseError
from haulcast.providers.geocoding.base import GeocodeCandidate
from haulcast.providers.geocoding.text import (
    join_label,
    normalize_country_code,
    optional_label,
    sanitize_label,
)
from haulcast.providers.http import UpstreamClient

PHOTON_URL: Final = "https://photon.komoot.io/api"
US_BIAS_LAT: Final = 39.5
US_BIAS_LON: Final = -98.35
"""Centre of the contiguous United States: ranks American places first without excluding others."""

_MAX_UPSTREAM_RESULTS: Final = 20
_KINDS: Final = frozenset(
    {"country", "state", "county", "city", "district", "locality", "street", "house"}
)
_OTHER_KIND: Final = "other"
_OSM_TYPES: Final = frozenset({"N", "W", "R"})
_MAX_OSM_ID: Final = 2**63 - 1
_MAX_LAT: Final = 90.0
_MAX_LON: Final = 180.0
_MIN_POSITION_LENGTH: Final = 2


class PhotonProvider:
    """Geocoding through Photon, biased towards the United States.

    The bias is a ranking hint, not a restriction: places elsewhere still come back when nothing
    nearer matches. Without it ``den`` ranks Denmark ahead of Denver.
    """

    name = "photon"

    def __init__(
        self,
        client: UpstreamClient,
        *,
        url: str = PHOTON_URL,
        bias_lat: float = US_BIAS_LAT,
        bias_lon: float = US_BIAS_LON,
    ) -> None:
        """Bind the ``client`` that performs the calls, the endpoint ``url`` and the bias point."""
        self._client = client
        self._url = url
        self._bias_lat = bias_lat
        self._bias_lon = bias_lon

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        """Return up to ``limit`` candidates for the (already normalised) ``query``, best first.

        Photon is asked for twice as many results as needed (at most twenty), so that removing
        duplicates and unusable features rarely leaves fewer than ``limit``.

        Raises:
            ValueError: ``limit`` is below one.
            ProviderError: the upstream failed (see
                :class:`~haulcast.providers.http.UpstreamClient`) or answered with a document
                that is not a GeoJSON feature collection.
        """
        if limit < 1:
            raise ValueError("limit must be at least 1")
        document = self._client.get_json(
            self._url,
            params={
                "q": query,
                "limit": min(limit * 2, _MAX_UPSTREAM_RESULTS),
                "lang": "en",
                "lat": self._bias_lat,
                "lon": self._bias_lon,
            },
        )
        found: dict[str, GeocodeCandidate] = {}
        for feature in self._features(document):
            candidate = _candidate(feature)
            if candidate is not None:
                found.setdefault(candidate.id, candidate)
                if len(found) == limit:
                    break
        return tuple(found.values())

    def _features(self, document: object) -> list[Mapping[str, object]]:
        """Return the feature objects of ``document``; anything but a collection is an error."""
        provider = self._client.provider
        if not isinstance(document, dict):
            raise ProviderResponseError(provider, "response is not a GeoJSON object")
        entries = document.get("features")
        if not isinstance(entries, list):
            raise ProviderResponseError(provider, "response has no features list")
        features: list[Mapping[str, object]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ProviderResponseError(provider, "response holds a feature that is no object")
            features.append(entry)
        return features


def _candidate(feature: Mapping[str, object]) -> GeocodeCandidate | None:
    """Map one feature to a candidate, or ``None`` when it lacks a usable id, name or point."""
    properties = feature.get("properties")
    point = _point(feature.get("geometry"))
    if not isinstance(properties, dict) or point is None:
        return None
    place_id = _place_id(properties)
    name = _name(properties)
    if place_id is None or name is None:
        return None
    city = optional_label(properties.get("city"))
    region = optional_label(properties.get("state"))
    country = optional_label(properties.get("country"))
    lat, lon = point
    return GeocodeCandidate(
        id=place_id,
        label=sanitize_label(join_label([name, city, region, country])),
        name=name,
        region=region,
        country=country,
        country_code=normalize_country_code(properties.get("countrycode")),
        kind=_kind(properties.get("type")),
        lat=lat,
        lon=lon,
    )


def _place_id(properties: Mapping[str, object]) -> str | None:
    """Return ``osm:<N|W|R><id>``, or ``None`` when the OSM type or id is missing or implausible."""
    osm_type = properties.get("osm_type")
    osm_id = properties.get("osm_id")
    if not (isinstance(osm_type, str) and osm_type in _OSM_TYPES):
        return None
    if isinstance(osm_id, bool) or not isinstance(osm_id, int) or not 0 < osm_id <= _MAX_OSM_ID:
        return None
    return f"osm:{osm_type}{osm_id}"


def _name(properties: Mapping[str, object]) -> str | None:
    """Return the feature's name, else its street line (housenumber and street), else ``None``."""
    name = optional_label(properties.get("name"))
    if name is not None:
        return name
    street = optional_label(properties.get("street"))
    if street is None:
        return None
    housenumber = optional_label(properties.get("housenumber"))
    return sanitize_label(f"{housenumber} {street}") if housenumber else street


def _kind(raw: object) -> str:
    """Return Photon's ``type`` when it is one of the kinds we expose, else ``other``."""
    return raw if isinstance(raw, str) and raw in _KINDS else _OTHER_KIND


def _point(geometry: object) -> tuple[float, float] | None:
    """Return ``(lat, lon)`` of a GeoJSON Point with a finite, in-range position, else ``None``.

    GeoJSON positions are ``[longitude, latitude]``.
    """
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        return None
    position = geometry.get("coordinates")
    if not isinstance(position, list) or len(position) < _MIN_POSITION_LENGTH:
        return None
    lon = _bounded(position[0], _MAX_LON)
    lat = _bounded(position[1], _MAX_LAT)
    if lat is None or lon is None:
        return None
    return lat, lon


def _bounded(value: object, bound: float) -> float | None:
    """Return ``value`` as a float when it is a JSON number within ``+-bound``, else ``None``.

    The range check comes before the conversion on purpose: it also rejects NaN and infinity, and
    a huge JSON integer is refused instead of overflowing ``float``.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if -bound <= value <= bound else None
