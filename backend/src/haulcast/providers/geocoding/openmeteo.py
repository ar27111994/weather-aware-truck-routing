"""Open-Meteo geocoding adapter: the city-level fallback behind Photon.

The service is GeoNames-backed, key-free and answers plain JSON. It knows places, not addresses: a
street address (or a one-character query) comes back as an object *without* a ``results`` key, which
is an ordinary "no match", not an error. This module holds only the protocol knowledge (request
parameters, response shape, field mapping). Retries, timeouts, size caps and the mapping of HTTP
failures onto :mod:`haulcast.providers.errors` live in
:class:`~haulcast.providers.http.UpstreamClient`, whose errors propagate unchanged.

As in the Photon adapter, a result that cannot be turned into a trustworthy candidate is skipped,
while a document whose envelope has the wrong shape is a
:class:`~haulcast.providers.errors.ProviderResponseError`.
"""

import math
from collections.abc import Mapping
from operator import itemgetter
from typing import Final

from haulcast.geo import MAX_LAT, MAX_LON, bounded_coordinate
from haulcast.providers.errors import ProviderResponseError
from haulcast.providers.geocoding.base import GeocodeCandidate
from haulcast.providers.geocoding.text import (
    join_label,
    normalize_country_code,
    optional_label,
    sanitize_label,
)
from haulcast.providers.http import UpstreamClient

OPEN_METEO_GEOCODING_URL: Final = "https://geocoding-api.open-meteo.com/v1/search"
DEFAULT_COUNTRY_CODE: Final = "US"

_MAX_UPSTREAM_RESULTS: Final = 20
_MAX_GEONAME_ID: Final = 2**63 - 1
_LOCALITY: Final = "locality"
_EXACT_KINDS: Final = {"ADM1": "state", "ADM2": "county"}


class OpenMeteoGeocodingProvider:
    """City-level geocoding through Open-Meteo, restricted to one country.

    The restriction is deliberate and is not one for the user: this is a partial index (see
    ``exhaustive``), so a search it cannot answer, an address or a place elsewhere, continues in
    the next provider of the chain, which is how "bias to the US, no hard restriction" holds.

    The upstream ranks by name match, which puts Salt Lake (Hawaii) ahead of Salt Lake City, so the
    results are re-ranked by population before they are cut to the requested size.
    """

    name = "open-meteo-geocoding"
    exhaustive = False
    """Cities of one country only: an empty answer sends the chain on to a wider index."""

    def __init__(
        self,
        client: UpstreamClient,
        *,
        url: str = OPEN_METEO_GEOCODING_URL,
        country_code: str = DEFAULT_COUNTRY_CODE,
    ) -> None:
        """Bind the ``client`` that performs the calls, the endpoint ``url`` and the country."""
        self._client = client
        self._url = url
        self._country_code = country_code

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        """Return up to ``limit`` candidates for the (already normalised) ``query``.

        Candidates are ordered by population, largest first; places without a population keep the
        upstream order after those that have one. An address-like query yields an empty tuple.

        Raises:
            ValueError: ``limit`` is below one.
            ProviderError: the upstream failed (see
                :class:`~haulcast.providers.http.UpstreamClient`) or answered with a document of
                the wrong shape.
        """
        if limit < 1:
            raise ValueError("limit must be at least 1")
        document = self._client.get_json(
            self._url,
            params={
                "name": query,
                "count": min(limit * 2, _MAX_UPSTREAM_RESULTS),
                "language": "en",
                "format": "json",
                "countryCode": self._country_code,
            },
        )
        ranked: list[tuple[float, GeocodeCandidate]] = []
        for entry in self._entries(document):
            candidate = _candidate(entry)
            if candidate is not None:
                ranked.append((_population(entry.get("population")), candidate))
        # list.sort is stable, also with reverse=True: equal populations keep the upstream order.
        ranked.sort(key=itemgetter(0), reverse=True)
        found: dict[str, GeocodeCandidate] = {}
        for _, candidate in ranked:
            found.setdefault(candidate.id, candidate)
            if len(found) == limit:
                break
        return tuple(found.values())

    def _entries(self, document: object) -> list[Mapping[str, object]]:
        """Return the result objects of ``document``; a document without ``results`` has none."""
        provider = self._client.provider
        if not isinstance(document, dict):
            raise ProviderResponseError(provider, "response is not a JSON object")
        if "results" not in document:
            return []
        results = document["results"]
        if not isinstance(results, list):
            raise ProviderResponseError(provider, "results is not a list")
        entries: list[Mapping[str, object]] = []
        for result in results:
            if not isinstance(result, dict):
                raise ProviderResponseError(provider, "results holds an entry that is no object")
            entries.append(result)
        return entries


def _candidate(entry: Mapping[str, object]) -> GeocodeCandidate | None:
    """Map one result to a candidate, or ``None`` when it lacks a usable id, name or position."""
    geoname_id = _geoname_id(entry.get("id"))
    name = optional_label(entry.get("name"))
    lat = bounded_coordinate(entry.get("latitude"), MAX_LAT)
    lon = bounded_coordinate(entry.get("longitude"), MAX_LON)
    if geoname_id is None or name is None or lat is None or lon is None:
        return None
    region = optional_label(entry.get("admin1"))
    country = optional_label(entry.get("country"))
    return GeocodeCandidate(
        id=f"geonames:{geoname_id}",
        label=sanitize_label(join_label([name, region, country])),
        name=name,
        region=region,
        country=country,
        country_code=normalize_country_code(entry.get("country_code")),
        kind=_kind(entry.get("feature_code")),
        lat=lat,
        lon=lon,
    )


def _geoname_id(raw: object) -> int | None:
    """Return the GeoNames id when it is a positive integer that fits 64 bits, else ``None``."""
    if isinstance(raw, bool) or not isinstance(raw, int) or not 0 < raw <= _MAX_GEONAME_ID:
        return None
    return raw


def _kind(feature_code: object) -> str:
    """Map a GeoNames feature code onto our kinds; anything unrecognised is a ``locality``.

    Populated places (``PPL``, ``PPLA``, ``PPLA2``, ...) are cities and political entities
    (``PCLI``, ``PCLD``, ...) are countries. First- and second-order divisions match exactly, so the
    historical ``ADM1H`` and the third-order ``ADM3`` stay localities.
    """
    if not isinstance(feature_code, str):
        return _LOCALITY
    if feature_code.startswith("PPL"):
        return "city"
    if feature_code.startswith("PCL"):
        return "country"
    return _EXACT_KINDS.get(feature_code, _LOCALITY)


def _population(raw: object) -> float:
    """Return the population for ranking; anything that is not a positive finite number is zero.

    The chained comparison rejects NaN, infinity, zero and negatives in one go, and never converts
    the value, so a huge JSON integer cannot overflow.
    """
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return 0
    return raw if 0 < raw < math.inf else 0
