"""Geocoding use case: validate and normalise the query, then answer from cache or the chain.

The cache key is the SHA-256 digest of the case-folded normalised query (so ``Denver``, ``denver ``
and ``DENVER`` share one entry, and no query is too long to store: R2-09) and the entry always holds
the provider's maximum number of results; the caller's ``limit`` only slices it. Entries live 30
days: place names barely change, and the free upstreams
ask us to cache. "Nothing found" lives an hour: it may be a provider's outage in disguise, and it
must not stick for a month (R2-16). An empty answer that may *be* an outage in disguise, because
the provider that could have found places failed or was skipped, is not stored at all: the search
answers empty and says so (:attr:`GeocodeSearch.conclusive`), so that nothing keeps a gap.

A search is interactive, so the whole of it (the cache miss and every provider it tries) runs
under :data:`~haulcast.config.timeouts.GEOCODE_BUDGET_S`.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from haulcast.config.timeouts import GEOCODE_BUDGET_S
from haulcast.problems import FieldError, ProblemCode, ProblemError
from haulcast.providers.deadline import deadline_scope
from haulcast.providers.geocoding.base import (
    GeocodeCandidate,
    GeocodingInconclusiveError,
    GeocodingProvider,
    GeocodingUnavailableError,
)
from haulcast.providers.geocoding.text import cache_digest, normalize_query
from haulcast.services.cache import CacheSpec, JsonCache, utc_now
from haulcast.store.models import GeocodeCache

MIN_QUERY_CHARS: Final = 2
MAX_QUERY_CHARS: Final = 120
MAX_RESULTS: Final = 8
CACHE_TTL: Final = timedelta(days=30)
EMPTY_CACHE_TTL: Final = timedelta(hours=1)
"""How long "nothing found" is remembered: enough to absorb a repeated query, short enough that a
provider's outage cannot pin a missing answer for a month."""
_FIELDS: Final = ("id", "label", "name", "region", "country", "country_code", "kind", "lat", "lon")

Candidates = tuple[GeocodeCandidate, ...]


@dataclass(frozen=True, slots=True)
class GeocodeSearch:
    """The normalised query and its candidate places, best match first."""

    query: str
    candidates: Candidates
    conclusive: bool = True
    """``False`` when ``candidates`` is empty only because a provider that could have found places
    failed or was skipped: the answer is no verdict on whether the place exists, so nothing may
    keep it (the cache table does not, and the API sends ``no-store``)."""


def _encode(candidates: Candidates) -> object:
    return [{field: getattr(candidate, field) for field in _FIELDS} for candidate in candidates]


def _lifetime(candidates: Candidates) -> timedelta:
    """Return how long an answer is kept: a month, but an empty one only an hour."""
    return CACHE_TTL if candidates else EMPTY_CACHE_TTL


def _decode(payload: object) -> Candidates:
    if not isinstance(payload, list):
        raise TypeError("geocode cache payload must be a list")
    return tuple(GeocodeCandidate(**{field: item[field] for field in _FIELDS}) for item in payload)


def geocode_cache(clock: Callable[[], datetime] = utc_now) -> JsonCache[Candidates, GeocodeCache]:
    """Build the production geocode cache (tests inject ``clock`` to expire entries)."""
    spec = CacheSpec[Candidates](
        name="geocode",
        provider="geocoding-chain",
        ttl=CACHE_TTL,
        encode=_encode,
        decode=_decode,
    )
    return JsonCache(spec, model=GeocodeCache, manager=GeocodeCache.objects, clock=clock)


class GeocodingService:
    """Turns a free-text query into candidate places."""

    def __init__(
        self, provider: GeocodingProvider, cache: JsonCache[Candidates, GeocodeCache]
    ) -> None:
        """Wire the (chained) ``provider`` and the read-through ``cache``."""
        self._provider = provider
        self._cache = cache

    def search(self, raw_query: str, limit: int) -> GeocodeSearch:
        """Return up to ``limit`` candidates for ``raw_query``.

        An empty answer that is no verdict (see :class:`GeocodeSearch`) comes back with
        ``conclusive=False`` and is stored nowhere.

        Raises:
            ProblemError: ``validation_error`` (422) for a query outside 2..120 characters after
                normalisation; ``geocoding_unavailable`` (503) when every provider failed.
        """
        query = normalize_query(raw_query)
        if not MIN_QUERY_CHARS <= len(query) <= MAX_QUERY_CHARS:
            message = f"q must be {MIN_QUERY_CHARS} to {MAX_QUERY_CHARS} characters long"
            raise ProblemError(
                ProblemCode.VALIDATION_ERROR,
                detail=f"q: {message}",
                errors=[FieldError(("query", "q"), message, "string_length")],
            )
        try:
            with deadline_scope(GEOCODE_BUDGET_S):
                candidates = self._cache.get_or_load(
                    f"geocode:{cache_digest(query)}",
                    lambda: self._provider.search(query, limit=MAX_RESULTS),
                    ttl_for=_lifetime,
                )
        except GeocodingInconclusiveError:
            # Not stored (it never left the loader) and not an outage either: the places this
            # query is about may well exist, so say "nothing" and say it is not a verdict.
            return GeocodeSearch(query=query, candidates=(), conclusive=False)
        except GeocodingUnavailableError as exc:
            raise ProblemError(
                ProblemCode.GEOCODING_UNAVAILABLE,
                detail="Place search is temporarily unavailable.",
                retry_after_s=exc.retry_after_s,
            ) from exc
        return GeocodeSearch(query=query, candidates=candidates[:limit])
