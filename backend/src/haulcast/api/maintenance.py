"""``POST|GET /api/v1/internal/maintenance``: the cron-triggered cleanup, behind a Bearer secret.

Vercel Cron only issues GET (a ``POST`` is kept for manual operation). The endpoint is
invisible (404) unless ``CRON_SECRET`` is configured and answers 401, with no detail, to any
other caller. The secret is compared with :func:`hmac.compare_digest`, so the response time
does not reveal how much of a guess was right.
"""

import hmac
from datetime import UTC, datetime

from django.conf import settings
from django.http import HttpRequest
from ninja import Router, Schema

from haulcast.api.schemas import COMMON_ERRORS, ProblemSchema
from haulcast.problems import ProblemError
from haulcast.services.maintenance import run_cleanup

router = Router(tags=["internal"])

_BEARER_PREFIX = "bearer "


class MaintenanceResponse(Schema):
    """Outcome of one maintenance run."""

    ran_at: datetime
    deleted: dict[str, int]


def _bearer_token(header: str | None) -> bytes | None:
    """Extract the token of an ``Authorization: Bearer <token>`` header, else ``None``."""
    if header is None or header[: len(_BEARER_PREFIX)].lower() != _BEARER_PREFIX:
        return None
    return header[len(_BEARER_PREFIX) :].strip().encode()


@router.api_operation(
    ["GET", "POST"],
    "/internal/maintenance",
    response={200: MaintenanceResponse, 401: ProblemSchema, 404: ProblemSchema, **COMMON_ERRORS},
    operation_id="runMaintenance",
    summary="Delete expired rows and keep the database active (Vercel Cron)",
)
def maintenance(request: HttpRequest) -> MaintenanceResponse:
    """Run the cleanup when the caller presents the configured Bearer secret."""
    secret = settings.HAULCAST_CRON_SECRET
    if secret is None:
        raise ProblemError("not_found")
    presented = _bearer_token(request.headers.get("Authorization"))
    if presented is None or not hmac.compare_digest(presented, secret.encode()):
        raise ProblemError("unauthorized")
    return MaintenanceResponse(ran_at=datetime.now(UTC), deleted=run_cleanup())
