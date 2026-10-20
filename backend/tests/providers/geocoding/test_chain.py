"""Tests of the geocoding chain: Photon first, Open-Meteo second, health-aware."""

import pytest

from haulcast.providers.errors import (
    ProviderRateLimitedError,
    ProviderRejectedError,
    ProviderResponseError,
    ProviderUnavailableError,
)
from haulcast.providers.geocoding.base import (
    GeocodeCandidate,
    GeocodingProvider,
    GeocodingUnavailableError,
)
from haulcast.providers.geocoding.chain import GeocodingChain
from haulcast.providers.health import ProviderHealth
from tests.providers.routing.support import FakeClock

Candidates = tuple[GeocodeCandidate, ...]


def place(place_id: str, name: str = "Denver") -> GeocodeCandidate:
    return GeocodeCandidate(
        id=place_id,
        label=f"{name}, Colorado, United States",
        name=name,
        region="Colorado",
        country="United States",
        country_code="US",
        kind="city",
        lat=39.7392,
        lon=-104.9903,
    )


class FakeProvider:
    """A scripted geocoding provider: each call pops the next outcome (a result or an error)."""

    def __init__(self, name: str, *outcomes: Candidates | Exception) -> None:
        self.name = name
        self._outcomes = list(outcomes)
        self.calls: list[tuple[str, int]] = []

    def search(self, query: str, *, limit: int) -> Candidates:
        self.calls.append((query, limit))
        outcome = self._outcomes.pop(0) if len(self._outcomes) > 1 else self._outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def chain_of(
    primary: GeocodingProvider,
    fallback: GeocodingProvider,
    clock: FakeClock | None = None,
) -> GeocodingChain:
    health = ProviderHealth(failure_threshold=3, cooldown_s=30.0, clock=clock or FakeClock())
    return GeocodingChain(primary, fallback, health=health)


def test_the_primary_answers_and_the_fallback_is_never_called() -> None:
    primary = FakeProvider("photon", (place("osm:R1"),))
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))

    found = chain_of(primary, fallback).search("denver", limit=5)

    assert found == (place("osm:R1"),)
    assert fallback.calls == []


def test_the_query_and_limit_reach_the_provider_unchanged() -> None:
    primary = FakeProvider("photon", (place("osm:R1"),))

    chain_of(primary, FakeProvider("open-meteo", ())).search("salt lake city", limit=8)

    assert primary.calls == [("salt lake city", 8)]


def test_no_match_is_a_valid_answer_and_does_not_wake_the_fallback() -> None:
    primary = FakeProvider("photon", ())
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))

    assert chain_of(primary, fallback).search("zzzzzz", limit=5) == ()
    assert fallback.calls == []


@pytest.mark.parametrize(
    "failure",
    [
        ProviderUnavailableError("photon", "HTTP 503"),
        ProviderRateLimitedError("photon", "rate limited (HTTP 429)", retry_after_s=2.0),
        ProviderResponseError("photon", "response is not valid JSON"),
        ProviderRejectedError("photon", "HTTP 400", status=400, code="400"),
    ],
    ids=["unavailable", "rate-limited", "garbled", "rejected"],
)
def test_any_provider_failure_falls_back_to_the_second_provider(failure: Exception) -> None:
    primary = FakeProvider("photon", failure)
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))

    assert chain_of(primary, fallback).search("denver", limit=5) == (place("geonames:2"),)
    assert fallback.calls == [("denver", 5)]


def test_when_both_fail_the_error_carries_the_largest_retry_hint() -> None:
    primary = FakeProvider(
        "photon", ProviderRateLimitedError("photon", "rate limited", retry_after_s=2.0)
    )
    fallback = FakeProvider(
        "open-meteo", ProviderUnavailableError("open-meteo", "HTTP 503", retry_after_s=9.0)
    )

    with pytest.raises(GeocodingUnavailableError) as excinfo:
        chain_of(primary, fallback).search("denver", limit=5)

    assert excinfo.value.retry_after_s == 9.0
    assert isinstance(excinfo.value.__cause__, ProviderUnavailableError)


def test_without_any_retry_hint_the_error_has_none() -> None:
    primary = FakeProvider("photon", ProviderResponseError("photon", "empty body"))
    fallback = FakeProvider("open-meteo", ProviderRejectedError("om", "HTTP 400", status=400))

    with pytest.raises(GeocodingUnavailableError) as excinfo:
        chain_of(primary, fallback).search("denver", limit=5)

    assert excinfo.value.retry_after_s is None


def test_a_bug_in_a_provider_is_not_swallowed() -> None:
    primary = FakeProvider("photon", ValueError("programming error"))
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))

    with pytest.raises(ValueError, match="programming error"):
        chain_of(primary, fallback).search("denver", limit=5)
    assert fallback.calls == []


def test_a_provider_that_keeps_failing_is_skipped_until_its_cooldown_ends() -> None:
    clock = FakeClock()
    primary = FakeProvider("photon", ProviderUnavailableError("photon", "HTTP 503"))
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))
    chain = chain_of(primary, fallback, clock)

    for _ in range(3):
        chain.search("denver", limit=5)
    assert len(primary.calls) == 3

    chain.search("denver", limit=5)  # circuit open: straight to the fallback
    assert len(primary.calls) == 3
    assert len(fallback.calls) == 4

    clock.advance(31.0)
    chain.search("denver", limit=5)  # half-open: the primary gets another chance
    assert len(primary.calls) == 4


def test_a_success_ends_the_failure_streak() -> None:
    primary = FakeProvider(
        "photon",
        ProviderUnavailableError("photon", "HTTP 503"),
        ProviderUnavailableError("photon", "HTTP 503"),
        (place("osm:R1"),),
        ProviderUnavailableError("photon", "HTTP 503"),
        ProviderUnavailableError("photon", "HTTP 503"),
    )
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))
    chain = chain_of(primary, fallback)

    for _ in range(5):
        chain.search("denver", limit=5)

    assert len(primary.calls) == 5  # never three failures in a row: never skipped


def test_rejections_caused_by_our_request_do_not_count_against_provider_health() -> None:
    primary = FakeProvider("photon", ProviderRejectedError("photon", "HTTP 400", status=400))
    fallback = FakeProvider("open-meteo", (place("geonames:2"),))
    chain = chain_of(primary, fallback)

    for _ in range(6):
        chain.search("denver", limit=5)

    assert len(primary.calls) == 6


def test_with_every_provider_cooling_down_the_chain_answers_without_calling_anyone() -> None:
    clock = FakeClock()
    primary = FakeProvider("photon", ProviderUnavailableError("photon", "HTTP 503"))
    fallback = FakeProvider("open-meteo", ProviderUnavailableError("open-meteo", "HTTP 503"))
    chain = chain_of(primary, fallback, clock)
    for _ in range(3):
        with pytest.raises(GeocodingUnavailableError):
            chain.search("denver", limit=5)
    calls = (len(primary.calls), len(fallback.calls))

    with pytest.raises(GeocodingUnavailableError):
        chain.search("denver", limit=5)

    assert (len(primary.calls), len(fallback.calls)) == calls


def test_the_chain_is_itself_a_geocoding_provider() -> None:
    chain: GeocodingProvider = chain_of(FakeProvider("a", ()), FakeProvider("b", ()))
    assert chain.name == "geocoding-chain"
