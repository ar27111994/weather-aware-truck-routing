"""Checkpoints along a route: where, when, and which miles each one stands for (DOMAIN-CONTRACT 6).

Checkpoints sit every ``interval_mi`` miles from the origin (``d_k = k * I`` while
``d_k < L - CHECKPOINT_EPSILON_MI``), then at the destination ``L``, so checkpoint 0 is the origin,
the last one is the destination and no near-duplicate final point is emitted: the count is
``ceil((L - epsilon) / I) + 1``. A checkpoint's position and elapsed time are interpolated along
the path (``locate``); its ETA is the departure plus that elapsed time, in UTC (no hours-of-service
breaks: a documented limitation).

Each checkpoint owns the stretch of road nearer to it than to its neighbours: the boundaries are
the midpoints between consecutive checkpoints, the origin owns ``[0, mid_0]`` and the destination
``[mid_last, L]``, so the owned miles add up to the route length.
"""

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Final

from haulcast.domain.errors import InvalidIntervalError, InvalidPathError, NaiveDatetimeError
from haulcast.domain.geometry import RoutePath, locate

CHECKPOINT_EPSILON_MI: Final = 0.01
"""A regular checkpoint must lie more than this short of the destination (no near-duplicate)."""


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """A point on the route where the weather is read, and the miles it stands for.

    ``distance_mi`` is measured along the route from the origin, ``eta`` is the UTC arrival time
    and ``owned_mi`` (always positive and finite) is the length of road whose risk this
    checkpoint's assessment represents in the route statistics.
    """

    index: int
    distance_mi: float
    lon: float
    lat: float
    eta: datetime
    owned_mi: float

    def __post_init__(self) -> None:
        """Reject owned miles that would corrupt the mile-weighted statistics."""
        if not (math.isfinite(self.owned_mi) and self.owned_mi > 0):
            raise InvalidPathError(
                f"checkpoint {self.index} must own a positive, finite number of miles, "
                f"got {self.owned_mi!r}"
            )


def plan_checkpoints(
    path: RoutePath, interval_mi: int, departure: datetime
) -> tuple[Checkpoint, ...]:
    """Place checkpoints every ``interval_mi`` miles along ``path`` for a ``departure`` time.

    Args:
        path: The validated route path (cumulative miles end at the provider's route length).
        interval_mi: Miles between checkpoints. Which intervals users may pick is the API's rule
            (``RiskRules.sampling_intervals_mi``); the domain only needs a positive whole number.
        departure: The departure instant, in any time zone; ETAs are returned in UTC.

    Raises:
        InvalidIntervalError: ``interval_mi`` is not a positive ``int`` (``bool`` is rejected).
        NaiveDatetimeError: ``departure`` has no time zone.
        InvalidPathError: The route is not longer than ``CHECKPOINT_EPSILON_MI``, so it has no
            distinct origin and destination checkpoints.
    """
    if type(interval_mi) is not int or interval_mi <= 0:
        raise InvalidIntervalError(
            f"interval_mi must be a positive whole number of miles, got {interval_mi!r}"
        )
    if departure.utcoffset() is None:
        raise NaiveDatetimeError("the departure time must be timezone-aware")
    length = path.length_mi
    if length <= CHECKPOINT_EPSILON_MI:
        raise InvalidPathError(
            f"the route must be longer than {CHECKPOINT_EPSILON_MI} mi to place checkpoints, "
            f"got {length!r} mi"
        )
    distances = _checkpoint_distances(length, interval_mi)
    start = departure.astimezone(UTC)
    checkpoints: list[Checkpoint] = []
    for index, (distance, owned) in enumerate(zip(distances, _owned_miles(distances), strict=True)):
        (lon, lat), elapsed_s = locate(path, distance)
        checkpoints.append(
            Checkpoint(
                index=index,
                distance_mi=distance,
                lon=lon,
                lat=lat,
                eta=start + timedelta(seconds=elapsed_s),
                owned_mi=owned,
            )
        )
    return tuple(checkpoints)


def _checkpoint_distances(length_mi: float, interval_mi: int) -> list[float]:
    """Return ``k * interval`` while short of ``length - epsilon``, then ``length`` itself."""
    last_regular = length_mi - CHECKPOINT_EPSILON_MI
    distances: list[float] = []
    distance = 0.0
    while distance < last_regular:
        distances.append(distance)
        distance = float(len(distances) * interval_mi)
    distances.append(length_mi)
    return distances


def _owned_miles(distances: list[float]) -> list[float]:
    """Return each checkpoint's share of the route: the stretch between neighbouring midpoints."""
    bounds = [distances[0], *((a + b) / 2 for a, b in pairwise(distances)), distances[-1]]
    return [high - low for low, high in pairwise(bounds)]
