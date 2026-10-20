"""Failure modes shared by every external provider adapter.

Adapters translate transport and protocol failures into these types, so services can choose between
retrying, falling back and answering with a ``problem+json`` document without ever handling a raw
upstream payload. Messages are safe to log and to keep in an exception chain: they never contain
credentials, request bodies or unbounded response text.
"""


class ProviderError(Exception):
    """Base class of every provider failure; ``provider`` names the upstream that failed."""

    def __init__(self, provider: str, message: str) -> None:
        """Record which ``provider`` failed and a log-safe ``message``."""
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message


class ProviderUnavailableError(ProviderError):
    """Timeout, connection failure or HTTP 5xx once the retry budget is spent.

    ``retry_after_s`` is the upstream's own hint when it sent one, so callers can pass it on.
    """

    def __init__(
        self,
        provider: str,
        message: str,
        *,
        retry_after_s: float | None = None,
    ) -> None:
        """Record the failure and the upstream's retry hint, if any."""
        super().__init__(provider, message)
        self.retry_after_s = retry_after_s


class ProviderRateLimitedError(ProviderUnavailableError):
    """The upstream answered HTTP 429, or a local budget refused the call on its behalf."""


class UpstreamBudgetExhaustedError(ProviderRateLimitedError):
    """A *local* allowance refused the call: the upstream was never asked and is not at fault.

    Callers map it like a 429 (clean "capacity" answer with ``retry_after_s``) but must not count
    it against the provider's health or fall back to another provider of the same allowance.
    """


class DeadlineExceededError(ProviderUnavailableError):
    """The request's time budget ended before an upstream could be asked, or while it answered.

    Raised before any call is made when too little time is left, so it says nothing about the
    provider's health either.
    """


class ProviderRejectedError(ProviderError):
    """The upstream answered HTTP 4xx (not 429) to a request we built: repeating it is pointless.

    ``code`` is the upstream's machine-readable error code when its body carried one (for example
    Valhalla's ``error_code`` 154 for a trip that is too long).
    """

    def __init__(
        self,
        provider: str,
        message: str,
        *,
        status: int,
        code: str | None = None,
    ) -> None:
        """Record the failure, the HTTP ``status`` and the upstream's error ``code``, if any."""
        super().__init__(provider, message)
        self.status = status
        self.code = code


class ProviderResponseError(ProviderError):
    """The upstream answered HTTP 2xx with a body we cannot interpret (empty, not JSON, ...)."""
