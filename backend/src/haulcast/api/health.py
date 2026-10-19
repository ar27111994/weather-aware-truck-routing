"""Liveness probe: proves the process is up and reports which build is running."""

from typing import Literal

from django.conf import settings
from django.http import HttpRequest
from ninja import Router, Schema

from haulcast import __version__

router = Router(tags=["health"])


class HealthResponse(Schema):
    """Body of ``GET /api/v1/health``."""

    status: Literal["ok"]
    version: str
    commit: str


@router.get(
    "/health",
    response=HealthResponse,
    operation_id="getHealth",
    summary="Liveness probe (never touches the database)",
)
def health(request: HttpRequest) -> HealthResponse:
    """Report liveness, the semantic version and the short git SHA of this build."""
    return HealthResponse(status="ok", version=__version__, commit=settings.HAULCAST_COMMIT)
