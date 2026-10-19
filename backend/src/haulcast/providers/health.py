"""Health tracking for provider chains: skip an upstream that keeps failing for a short cooldown.

After ``failure_threshold`` consecutive failures a provider is considered *open* (unavailable) for
``cooldown_s`` seconds, so callers go straight to the fallback instead of paying a timeout on every
request. When the cooldown ends the provider is tried again (half-open): one success closes it, one
more failure re-opens it immediately. State is per process, which is exactly right for serverless
instances: each instance learns independently and forgets on recycle.
"""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

DEFAULT_FAILURE_THRESHOLD: Final = 3
DEFAULT_COOLDOWN_S: Final = 30.0


@dataclass(slots=True)
class _State:
    consecutive_failures: int = 0
    open_until: float = 0.0


class ProviderHealth:
    """Thread-safe consecutive-failure tracker with a cooldown, keyed by provider name."""

    def __init__(
        self,
        *,
        failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
        cooldown_s: float = DEFAULT_COOLDOWN_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Configure the streak length that opens a circuit, the cooldown and the time source."""
        self._failure_threshold = failure_threshold
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._lock = threading.Lock()
        self._states: dict[str, _State] = {}

    def available(self, name: str) -> bool:
        """Return ``False`` while ``name`` is inside its post-failure cooldown."""
        with self._lock:
            state = self._states.get(name)
            return state is None or self._clock() >= state.open_until

    def record_success(self, name: str) -> None:
        """Close the circuit for ``name``: its failure streak ends."""
        with self._lock:
            self._states.pop(name, None)

    def record_failure(self, name: str) -> None:
        """Count a failure; reaching the threshold opens the circuit for the cooldown."""
        with self._lock:
            state = self._states.setdefault(name, _State())
            state.consecutive_failures += 1
            if state.consecutive_failures >= self._failure_threshold:
                state.open_until = self._clock() + self._cooldown_s
