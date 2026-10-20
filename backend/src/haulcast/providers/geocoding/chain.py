"""Photon first, Open-Meteo second: the geocoding chain behind the service.

Policy, chosen so that the cheap path stays cheap and the fallback only helps when it can:

* The primary (Photon) answers whenever it can. An *empty* answer is an answer: Open-Meteo's
  city-level index cannot know a place the street-level index does not, and asking it anyway
  would double the upstream traffic of every search-as-you-type keystroke that matches nothing.
* Any provider failure (timeout, 5xx, 429, a garbled body, a rejection) moves on to the next
  provider. Failures that say something about the *provider's* health (unavailable, rate limited,
  garbled) feed the cooldown tracker, so a provider that keeps failing is skipped for a while
  instead of costing a timeout on every request. A rejection (HTTP 4xx) means *our* request was
  refused, which says nothing about the provider's health, so it is not counted.
* When nobody can answer, :class:`GeocodingUnavailableError` carries the longest ``Retry-After``
  hint any provider gave, so the API can pass it on.
* Anything that is not a :class:`ProviderError` is a bug and propagates unchanged.
"""

from collections.abc import Sequence
from typing import Final

from haulcast.providers.errors import (
    ProviderError,
    ProviderRejectedError,
    ProviderUnavailableError,
)
from haulcast.providers.geocoding.base import (
    GeocodeCandidate,
    GeocodingProvider,
    GeocodingUnavailableError,
)
from haulcast.providers.health import ProviderHealth

CHAIN_NAME: Final = "geocoding-chain"


def _retry_hint(failures: Sequence[ProviderError]) -> float | None:
    """Return the longest ``Retry-After`` any failure carried, or ``None`` if none did."""
    hints = [
        failure.retry_after_s
        for failure in failures
        if isinstance(failure, ProviderUnavailableError) and failure.retry_after_s is not None
    ]
    return max(hints, default=None)


class GeocodingChain:
    """Tries the geocoding providers in order and answers with the first usable result."""

    name = CHAIN_NAME

    def __init__(
        self,
        primary: GeocodingProvider,
        fallback: GeocodingProvider,
        *,
        health: ProviderHealth,
    ) -> None:
        """Order the providers and share the ``health`` tracker that decides who is skipped."""
        self._providers = (primary, fallback)
        self._health = health

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        """Return up to ``limit`` candidates from the first provider that can answer.

        Raises:
            GeocodingUnavailableError: every provider failed or is cooling down after failures.
        """
        failures: list[ProviderError] = []
        for provider in self._providers:
            if not self._health.available(provider.name):
                continue
            try:
                found = provider.search(query, limit=limit)
            except ProviderError as exc:
                if not isinstance(exc, ProviderRejectedError):
                    self._health.record_failure(provider.name)
                failures.append(exc)
                continue
            self._health.record_success(provider.name)
            return found
        error = GeocodingUnavailableError(
            "every geocoding provider failed", retry_after_s=_retry_hint(failures)
        )
        if failures:
            raise error from failures[-1]
        raise error
