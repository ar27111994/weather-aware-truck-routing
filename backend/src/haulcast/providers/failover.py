"""Operational visibility for provider chains: who failed, who was skipped, never what was asked.

Both chains hide provider trouble from the caller on purpose (the next provider answers), so
without a log line the outage of a primary is invisible: only per-attempt outcomes reach the access
log, and ops cannot see "Photon is down, serving Open-Meteo" (R2-24). These helpers write one
structured event per failure and per provider skipped for its cooldown.

Messages carry the chain, the provider name and the failure *class* only. They never contain the
query, a coordinate or the upstream's own text: what the chains are asked about are places users
typed or picked.
"""

import logging

from haulcast.providers.errors import (
    DeadlineExceededError,
    ProviderError,
    ProviderRejectedError,
    UpstreamBudgetExhaustedError,
)

logger = logging.getLogger("haulcast.providers")

_NOT_THE_PROVIDERS_FAULT = (
    ProviderRejectedError,
    DeadlineExceededError,
    UpstreamBudgetExhaustedError,
)


def blames_provider(error: ProviderError) -> bool:
    """Return whether ``error`` says something about the health of the provider that raised it.

    A rejection (HTTP 4xx) is about *our* request, an exhausted deadline about *our* time and a
    refused budget about *our* allowance: none of them means the provider is struggling, so none
    may open its circuit.
    """
    return not isinstance(error, _NOT_THE_PROVIDERS_FAULT)


def record_failover(chain: str, provider: str, error: ProviderError) -> None:
    """Log that ``provider`` of ``chain`` failed with ``error``'s class and the chain moves on."""
    logger.warning(
        "%s: %s failed with %s",
        chain,
        provider,
        type(error).__name__,
        extra={"event": "provider_failover", "upstream": provider},
    )


def record_skip(chain: str, provider: str) -> None:
    """Log that ``provider`` of ``chain`` is skipped because it is cooling down after failures."""
    logger.warning(
        "%s: %s is cooling down after repeated failures and is skipped",
        chain,
        provider,
        extra={"event": "provider_circuit_open", "upstream": provider},
    )
