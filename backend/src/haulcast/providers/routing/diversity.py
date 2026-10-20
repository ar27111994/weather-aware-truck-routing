"""Route distinctness: when two routes count as different options, and how hard to look for them.

The product promises three route options. Routing engines often return fewer (the Valhalla public
server's ``alternates=2`` returned 3 / 3 / 2 / 1 / 1 routes on the five trips probed), and the
ones they return can be near-duplicates. Two routes are *distinct* when the share of one that runs
along the other (within a tolerance) is below ``overlap_threshold``; a candidate must be distinct
from **every** route already kept. The numbers are the ones the forced-diversity strategy was
calibrated with (PROVIDERS.md Q2); Chicago to Denver sits at 0.796 / 0.798 against 0.80, so they
are part of the contract, not tuning knobs, and are pinned by tests on the real recordings.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from haulcast.providers.routing.base import RouteOption
from haulcast.providers.routing.geometry import is_distinct_route

TARGET_ROUTES: Final = 3
"""How many distinct routes the product wants per trip."""


@dataclass(frozen=True, slots=True)
class DiversityPolicy:
    """How routes are compared and how far the search for missing options may go."""

    target_routes: int = TARGET_ROUTES
    overlap_threshold: float = 0.80
    """A candidate sharing at least this fraction of its length with a kept route is a duplicate."""
    tolerance_m: float = 250.0
    """Two samples closer than this count as the same road."""
    step_m: float = 100.0
    """Routes are resampled to about this spacing before they are compared."""
    anchor_fractions: tuple[float, ...] = (0.5, 0.25, 0.75, 0.4, 0.6)
    """Places along the first route (as fractions of its length) to push the engine away from."""
    polygon_half_size_deg: float = 0.01
    """Half the side of the square excluded around an anchor (Valhalla caps a ring at 10 km)."""
    max_extra_calls: int = 3
    """Upper bound on additional engine calls per trip: D-17 says three at most.

    T1 recorded a trip that needs six to reach three routes (Dallas to Atlanta); with three it
    returns two and the ``fewer_than_3_distinct_routes`` warning. Raising this is a decision for
    D-17 (and for the 1 s spacing every call costs), not a tuning knob.
    """
    stage_budget_s: float = 10.0
    """No extra call starts after this much time has passed since the trip's first call (D-17)."""

    def __post_init__(self) -> None:
        """Reject values that would make the search meaningless or unbounded."""
        if self.target_routes < 1:
            raise ValueError("target_routes must be at least 1")
        if not 0.0 < self.overlap_threshold <= 1.0:
            raise ValueError("overlap_threshold must be in (0, 1]")
        if not (self.tolerance_m > 0 and self.step_m > 0):
            raise ValueError("tolerance_m and step_m must be positive")
        if not all(0.0 <= fraction <= 1.0 for fraction in self.anchor_fractions):
            raise ValueError("anchor fractions must be between 0 and 1")
        if not (math.isfinite(self.polygon_half_size_deg) and self.polygon_half_size_deg > 0):
            raise ValueError("polygon_half_size_deg must be a positive number")
        if self.max_extra_calls < 0:
            raise ValueError("max_extra_calls must not be negative")
        if not (math.isfinite(self.stage_budget_s) and self.stage_budget_s > 0):
            raise ValueError("stage_budget_s must be a positive number")


DEFAULT_DIVERSITY: Final = DiversityPolicy()


def is_distinct(
    candidate: RouteOption, kept: Sequence[RouteOption], policy: DiversityPolicy
) -> bool:
    """Return whether ``candidate`` differs from every route in ``kept`` under ``policy``."""
    return is_distinct_route(
        candidate.coords,
        (route.coords for route in kept),
        threshold=policy.overlap_threshold,
        tolerance_m=policy.tolerance_m,
        step_m=policy.step_m,
    )


def distinct_routes(
    candidates: Sequence[RouteOption], policy: DiversityPolicy
) -> list[RouteOption]:
    """Keep the candidates distinct from all earlier kept ones, in order, up to the target.

    The cap lives here so that no adapter can exceed it: OSRM is asked for three alternatives, so
    a plan could otherwise carry four routes where the product shows exactly three (R2-21).
    """
    kept: list[RouteOption] = []
    for candidate in candidates:
        if len(kept) == policy.target_routes:
            break
        if is_distinct(candidate, kept, policy):
            kept.append(candidate)
    return kept
