"""Ordered geocoding providers: the fast city index first, the street-level index when it matters.

Policy, chosen so that the cheap path stays cheap and the next provider only helps when it can:

* The first provider with a *conclusive* answer wins. A non-empty answer is conclusive. An empty
  answer is conclusive only from an ``exhaustive`` provider (Photon's street-level index of the
  world has no place the next provider could add, and asking anyway would double the traffic of
  every search-as-you-type keystroke that matches nothing). From a partial index (Open-Meteo's
  cities of one country) an empty answer only says "not in my index": the next provider is asked.
  That is also what keeps the country restriction of that index from being a hard restriction on
  what a user can find (API contract: "bias to the US, no hard restriction").
* When every provider answered empty and nobody failed or was skipped, the chain answers empty:
  nobody is left who could add a place. When a provider answered empty from a partial index and
  the one that could say more failed or is cooling down, "not in my index" is no verdict: the
  chain raises :class:`GeocodingInconclusiveError`, because an outage of the street-level index
  would otherwise become "no such place" for as long as that answer is kept. The service answers
  such a search empty and stores nothing, and the API tells browsers and the CDN to keep nothing.
* Any provider failure (timeout, 5xx, 429, a garbled body, a rejection) moves on to the next
  provider and is logged as a ``provider_failover`` event. Failures that say something about the
  *provider's* health (unavailable, rate limited, garbled) feed the cooldown tracker, so a provider
  that keeps failing is skipped for a while instead of costing a timeout on every request; the
  skip is logged too. A rejection (HTTP 4xx: our request), an exhausted deadline (our time) and a
  refused local budget (our allowance) say nothing about the provider and are not counted.
* When nobody can answer, :class:`GeocodingUnavailableError` carries the longest ``Retry-After``
  hint any provider gave, so the API can pass it on.
* Anything that is not a :class:`ProviderError` is a bug and propagates unchanged.
"""

from collections.abc import Sequence
from typing import Final

from haulcast.providers.errors import ProviderError, ProviderUnavailableError
from haulcast.providers.failover import blames_provider, record_failover, record_skip
from haulcast.providers.geocoding.base import (
    GeocodeCandidate,
    GeocodingInconclusiveError,
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
    """Tries the geocoding providers in order and answers with the first conclusive result."""

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

    @property
    def exhaustive(self) -> bool:
        """Whether the chain's empty answer is final: true when its last provider is exhaustive."""
        return self._providers[-1].exhaustive

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        """Return up to ``limit`` candidates from the first provider with a conclusive answer.

        Raises:
            GeocodingInconclusiveError: a provider answered "nothing", but another one that could
                have added to that failed or is cooling down, so there is no verdict.
            GeocodingUnavailableError: every provider failed or is cooling down after failures
                (and none of them answered, not even with "nothing").
        """
        failures: list[ProviderError] = []
        answered_empty = False
        skipped = False
        for provider in self._providers:
            if not self._health.available(provider.name):
                record_skip(CHAIN_NAME, provider.name)
                skipped = True
                continue
            try:
                found = provider.search(query, limit=limit)
            except ProviderError as exc:
                if blames_provider(exc):
                    self._health.record_failure(provider.name)
                failures.append(exc)
                record_failover(CHAIN_NAME, provider.name, exc)
                continue
            self._health.record_success(provider.name)
            if found or provider.exhaustive:
                return found
            answered_empty = True
        retry_after_s = _retry_hint(failures)
        if answered_empty:
            if not failures and not skipped:
                return ()
            error: GeocodingUnavailableError = GeocodingInconclusiveError(
                "no provider found a place and one could not be asked", retry_after_s=retry_after_s
            )
        else:
            error = GeocodingUnavailableError(
                "every geocoding provider failed", retry_after_s=retry_after_s
            )
        if failures:
            raise error from failures[-1]
        raise error
