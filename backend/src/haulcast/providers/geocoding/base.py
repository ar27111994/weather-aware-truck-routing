"""Provider-neutral geocoding types and the interface every geocoding adapter implements."""

from dataclasses import dataclass
from typing import Protocol

from haulcast.providers.errors import ProviderError


@dataclass(frozen=True, slots=True)
class GeocodeCandidate:
    """One place matching a query, shaped like an entry of ``GET /api/v1/geocode`` results.

    Every text field is plain data: control characters are already stripped and lengths capped, but
    nothing is HTML-escaped (consumers render it as text), so labels such as ``<script>`` pass
    through verbatim.
    """

    id: str
    label: str
    name: str
    region: str | None
    country: str | None
    country_code: str | None
    kind: str
    lat: float
    lon: float


class GeocodingUnavailableError(ProviderError):
    """Every geocoding provider failed; ``retry_after_s`` carries the upstream's hint when known."""

    def __init__(self, message: str, *, retry_after_s: float | None = None) -> None:
        """Record the failure and the upstream's retry hint, if any."""
        super().__init__("geocoding", message)
        self.retry_after_s = retry_after_s


class GeocodingInconclusiveError(GeocodingUnavailableError):
    """No provider found a place, and one that could have added to that answer did not answer.

    A partial index (the cities of one country) only says "not in my index". When the index that
    could say more failed or is cooling down, "nothing found" is no verdict, and answering empty
    would let it be stored as if it were one: a provider's outage would become a missing place for
    as long as the answer is kept. This error is how the chain says so. It is a
    :class:`GeocodingUnavailableError`, so a caller that does not know it fails loudly (an outage)
    rather than storing a gap; the geocoding service turns it into an empty answer that nothing
    keeps.
    """


class GeocodingProvider(Protocol):
    """Turns free text into candidate places, best match first."""

    name: str

    @property
    def exhaustive(self) -> bool:
        """Whether an empty answer means "no such place" for every query.

        ``False`` for an index that covers only part of the world (the cities of one country):
        its empty answer only means "not in my index", and a chain asks the next provider.
        """
        ...

    def search(self, query: str, *, limit: int) -> tuple[GeocodeCandidate, ...]:
        """Return up to ``limit`` candidates for the (already normalised) ``query``.

        Raises:
            ProviderError: the upstream failed (see :mod:`haulcast.providers.errors`).
        """
        ...
