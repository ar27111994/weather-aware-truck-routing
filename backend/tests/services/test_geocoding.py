"""The geocoding use case: normalisation, validation, 30-day caching and failure mapping."""

import logging
from datetime import UTC, datetime, timedelta

import pytest

from haulcast.config.timeouts import GEOCODE_BUDGET_S
from haulcast.problems import ProblemError
from haulcast.providers.deadline import current_deadline, deadline_scope
from haulcast.providers.geocoding.base import (
    GeocodeCandidate,
    GeocodingInconclusiveError,
    GeocodingUnavailableError,
)
from haulcast.services.geocoding import (
    CACHE_TTL,
    EMPTY_CACHE_TTL,
    MAX_QUERY_CHARS,
    MAX_RESULTS,
    GeocodeSearch,
    GeocodingService,
    geocode_cache,
)
from haulcast.store.models import GeocodeCache

NOON = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)

pytestmark = pytest.mark.django_db


def place(index: int, *, label: str | None = None) -> GeocodeCandidate:
    """A distinct candidate; ``label`` overrides the display text."""
    return GeocodeCandidate(
        id=f"osm:N{index}",
        label=label or f"Place {index}, Colorado, United States",
        name=f"Place {index}",
        region="Colorado" if index % 2 else None,
        country="United States" if index % 3 else None,
        country_code="US" if index % 3 else None,
        kind="city",
        lat=39.0 + index / 100,
        lon=-104.0 - index / 100,
    )


class FakeProvider:
    """A geocoding provider that records its calls."""

    name = "fake"
    exhaustive = True

    def __init__(self, results: int = 10, failure: GeocodingUnavailableError | None = None) -> None:
        self.candidates = tuple(place(index) for index in range(results))
        self.failure = failure
        self.calls: list[tuple[str, int]] = []

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        self.calls.append((query, limit))
        if self.failure is not None:
            raise self.failure
        return self.candidates[:limit]


def service(provider: FakeProvider, clock: datetime = NOON) -> GeocodingService:
    return GeocodingService(provider, geocode_cache(lambda: clock))


# --------------------------------------------------------------------------- results


def test_the_query_is_normalised_and_echoed() -> None:
    result = service(FakeProvider()).search("  Den \t VER\n", 5)

    assert result.query == "Den VER"


def test_the_provider_is_always_asked_for_the_maximum_and_the_caller_gets_a_slice() -> None:
    provider = FakeProvider()

    three = service(provider).search("denver", 3)

    assert provider.calls == [("denver", MAX_RESULTS)]
    assert three.candidates == provider.candidates[:3]
    assert isinstance(three, GeocodeSearch)


def test_a_larger_limit_is_served_from_the_same_cached_entry() -> None:
    provider = FakeProvider()
    geocoder = service(provider)

    geocoder.search("denver", 2)
    everything = geocoder.search("denver", MAX_RESULTS)

    assert len(provider.calls) == 1
    assert everything.candidates == provider.candidates[:MAX_RESULTS]


@pytest.mark.parametrize("variant", ["Denver", "denver ", "  DENVER", "dEnVeR", "Den\u200bver"])
def test_spelling_variants_share_one_cache_entry(variant: str) -> None:
    provider = FakeProvider()
    geocoder = service(provider)

    geocoder.search("denver", 5)
    geocoder.search(variant, 5)

    assert len(provider.calls) == 1
    assert GeocodeCache.objects.count() == 1


def test_a_cold_service_instance_reads_the_stored_answer() -> None:
    provider = FakeProvider()
    service(provider).search("denver", 5)

    again = service(provider).search("denver", 5)

    assert len(provider.calls) == 1
    assert again.candidates == provider.candidates[:5]


def test_optional_fields_survive_the_cache_round_trip() -> None:
    provider = FakeProvider()
    service(provider).search("denver", 8)

    cached = service(FakeProvider(results=0)).search("denver", 8)

    assert cached.candidates == provider.candidates[:MAX_RESULTS]
    assert any(candidate.region is None for candidate in cached.candidates)
    assert any(candidate.country_code is None for candidate in cached.candidates)


def test_entries_live_for_thirty_days() -> None:
    service(FakeProvider()).search("denver", 5)

    row = GeocodeCache.objects.get()
    assert timedelta(days=30) == CACHE_TTL
    assert row.expires_at == NOON + timedelta(days=30)
    assert row.provider == "geocoding-chain"
    assert row.key == "geocode:denver"


def test_an_entry_older_than_thirty_days_is_fetched_again() -> None:
    provider = FakeProvider()
    service(provider, NOON).search("denver", 5)

    service(provider, NOON + timedelta(days=31)).search("denver", 5)

    assert len(provider.calls) == 2


def test_an_empty_answer_is_an_answer_and_is_cached() -> None:
    provider = FakeProvider(results=0)
    geocoder = service(provider)

    assert geocoder.search("nowhere-at-all", 5).candidates == ()
    assert geocoder.search("nowhere-at-all", 5).candidates == ()
    assert len(provider.calls) == 1


def test_an_empty_answer_is_remembered_for_an_hour_not_for_a_month() -> None:
    # R2-16: "nothing found" may be an outage of a provider in disguise; it must not stick.
    service(FakeProvider(results=0)).search("nowhere-at-all", 5)

    assert timedelta(hours=1) == EMPTY_CACHE_TTL
    assert GeocodeCache.objects.get().expires_at == NOON + EMPTY_CACHE_TTL


def test_an_empty_answer_is_asked_again_once_its_hour_is_over() -> None:
    provider = FakeProvider(results=0)
    service(provider, NOON).search("nowhere-at-all", 5)

    service(provider, NOON + EMPTY_CACHE_TTL + timedelta(minutes=1)).search("nowhere-at-all", 5)

    assert len(provider.calls) == 2


def test_an_inconclusive_empty_answer_is_returned_but_never_stored() -> None:
    # The city index found nothing and the street index, which might have, could not be asked:
    # that may be an outage in disguise, and an hour of "no such place" is a long time for it.
    provider = FakeProvider(failure=GeocodingInconclusiveError("the street index is down"))
    geocoder = service(provider)

    first = geocoder.search("1 main street", 5)
    second = geocoder.search("1 main street", 5)

    assert (first.candidates, first.conclusive) == ((), False)
    assert (second.candidates, second.conclusive) == ((), False)
    assert len(provider.calls) == 2, "nothing was remembered, so the second search asked again"
    assert GeocodeCache.objects.count() == 0


@pytest.mark.parametrize("results", [0, 3], ids=["nothing-found", "places-found"])
def test_what_a_provider_established_is_conclusive(results: int) -> None:
    assert service(FakeProvider(results=results)).search("denver", 5).conclusive is True


class DeadlineSpy(FakeProvider):
    """A provider that notes how much of the request's time is left when it is asked."""

    def __init__(self) -> None:
        super().__init__()
        self.remaining: list[float] = []

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        deadline = current_deadline()
        assert deadline is not None, "a search runs under a deadline"
        self.remaining.append(deadline.remaining())
        return super().search(query, limit=limit)


def test_a_search_runs_under_the_geocoding_budget() -> None:
    spy = DeadlineSpy()

    service(spy).search("denver", 5)

    assert GEOCODE_BUDGET_S - 0.5 < spy.remaining[0] <= GEOCODE_BUDGET_S


def test_a_shorter_deadline_of_the_caller_is_not_extended_by_the_budget() -> None:
    spy = DeadlineSpy()

    with deadline_scope(1.0):
        service(spy).search("denver", 5)

    assert spy.remaining[0] <= 1.0


# --------------------------------------------------------------------------- hostile input


def test_markup_in_the_query_and_in_labels_is_data_not_something_to_interpret() -> None:
    attack = "<script>alert(1)</script>"
    provider = FakeProvider()
    provider.candidates = (place(1, label='<img src=x onerror="alert(1)"> & "quotes"'),)
    geocoder = service(provider)

    first = geocoder.search(attack, 5)
    second = service(FakeProvider(results=0)).search(attack, 5)  # cold read from the table

    assert provider.calls == [(attack, MAX_RESULTS)]
    assert first.query == attack
    assert first.candidates == second.candidates
    assert second.candidates[0].label == '<img src=x onerror="alert(1)"> & "quotes"'


@pytest.mark.parametrize(
    ("raw", "normalised"),
    [
        ("\uff24\uff45\uff4e\uff56\uff45\uff52", "Denver"),  # fullwidth letters fold (NFKC)
        ("Zürich", "Zürich"),
        ("北京", "北京"),
        ("São\u00a0Paulo", "São Paulo"),
        ("Sprin\x00gfield\x1b[0m", "Springfield[0m"),
    ],
)
def test_unicode_queries_are_normalised_and_control_characters_vanish(
    raw: str, normalised: str
) -> None:
    provider = FakeProvider()

    result = service(provider).search(raw, 5)

    assert result.query == normalised
    assert provider.calls == [(normalised, MAX_RESULTS)]


@pytest.mark.parametrize(
    "raw", ["", "a", "  a  ", " \t\n", "\x00\x01", "x" * (MAX_QUERY_CHARS + 1)]
)
def test_queries_outside_two_to_one_twenty_characters_are_a_422_before_any_upstream_call(
    raw: str,
) -> None:
    provider = FakeProvider()

    with pytest.raises(ProblemError) as raised:
        service(provider).search(raw, 5)

    error = raised.value
    assert (error.code, error.status) == ("validation_error", 422)
    assert error.detail == "q: q must be 2 to 120 characters long"
    assert [(field.loc, field.type) for field in error.errors] == [
        (("query", "q"), "string_length")
    ]
    assert provider.calls == []


@pytest.mark.parametrize("raw", ["ab", "x" * MAX_QUERY_CHARS, "  ab  "])
def test_the_length_bounds_are_inclusive(raw: str) -> None:
    assert service(FakeProvider()).search(raw, 1).candidates


# --------------------------------------------------------------------------- failures


def test_when_every_provider_failed_the_answer_is_a_503_with_the_upstreams_retry_hint() -> None:
    provider = FakeProvider(failure=GeocodingUnavailableError("all failed", retry_after_s=42.0))

    with pytest.raises(ProblemError) as raised:
        service(provider).search("denver", 5)

    error = raised.value
    assert (error.code, error.status, error.retry_after_s) == ("geocoding_unavailable", 503, 42.0)
    assert error.detail == "Place search is temporarily unavailable."
    assert GeocodeCache.objects.count() == 0


def test_an_unavailable_answer_without_a_hint_has_no_retry_after() -> None:
    provider = FakeProvider(failure=GeocodingUnavailableError("all failed"))

    with pytest.raises(ProblemError) as raised:
        service(provider).search("denver", 5)

    assert raised.value.retry_after_s is None


def test_a_failure_is_not_cached_so_the_next_request_tries_again() -> None:
    provider = FakeProvider(failure=GeocodingUnavailableError("all failed"))
    geocoder = service(provider)
    for _ in range(2):
        with pytest.raises(ProblemError):
            geocoder.search("denver", 5)

    assert len(provider.calls) == 2


# --------------------------------------------------------------------------- damaged cache rows


@pytest.mark.parametrize(
    "payload",
    [{"not": "a list"}, ["not", "dicts"], [{"id": "osm:N1"}], 7],
    ids=["object", "strings", "missing-fields", "scalar"],
)
def test_a_damaged_stored_payload_is_a_miss_that_is_repaired(
    payload: object, caplog: pytest.LogCaptureFixture
) -> None:
    GeocodeCache.objects.create(
        key="geocode:denver", payload=payload, provider="old", expires_at=NOON + timedelta(days=1)
    )
    provider = FakeProvider()

    with caplog.at_level(logging.WARNING, logger="haulcast.cache"):
        result = service(provider).search("denver", 5)

    assert result.candidates == provider.candidates[:5]
    assert "cache_payload_undecodable" in caplog.text
    assert GeocodeCache.objects.get(key="geocode:denver").provider == "geocoding-chain"
