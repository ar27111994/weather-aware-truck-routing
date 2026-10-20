"""Persistence of plans: lookup by id, idempotency window, 7-day expiry, the lazily stored heatmap.

Plans are plain rows of the ``plan`` table (``Plan``). ``request_hash`` plus ``created_at`` serve
the idempotency lookup and ``expires_at`` the cleanup job; the cleanup job (and these lookups)
treat an expired plan as gone, so a plan is never served after its 7 days.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from haulcast.services.cache import utc_now
from haulcast.services.plan_ids import PLAN_ID_PATTERN, new_plan_id
from haulcast.store.models import Plan

PLAN_TTL: Final = timedelta(days=7)
IDEMPOTENCY_WINDOW: Final = timedelta(minutes=10)


@dataclass(frozen=True, slots=True)
class Runtime:
    """The clock and the id source of the use cases, injectable so tests are deterministic."""

    clock: Callable[[], datetime] = utc_now
    new_id: Callable[[datetime], str] = new_plan_id
    monotonic: Callable[[], float] = time.monotonic


def find_recent(request_hash: str, now: datetime) -> Plan | None:
    """Return the newest unexpired plan made for ``request_hash`` within the idempotency window."""
    return (
        Plan.objects.filter(
            request_hash=request_hash,
            created_at__gt=now - IDEMPOTENCY_WINDOW,
            expires_at__gt=now,
        )
        .order_by("-created_at")
        .first()
    )


def get_plan(plan_id: str, now: datetime) -> Plan | None:
    """Return the unexpired plan ``plan_id``; a malformed id is simply unknown (no query)."""
    if not PLAN_ID_PATTERN.fullmatch(plan_id):
        return None
    return Plan.objects.filter(id=plan_id, expires_at__gt=now).first()


def add_plan(
    plan_id: str,
    request_hash: str,
    request: dict[str, object],
    result: dict[str, object],
    created_at: datetime,
) -> Plan:
    """Store a new plan that expires 7 days after ``created_at``."""
    return Plan.objects.create(
        id=plan_id,
        request_hash=request_hash,
        request=request,
        result=result,
        created_at=created_at,
        expires_at=created_at + PLAN_TTL,
    )


def save_heatmap(plan_id: str, heatmap: dict[str, object]) -> None:
    """Attach the computed heatmap to its plan."""
    Plan.objects.filter(id=plan_id).update(heatmap=heatmap)
