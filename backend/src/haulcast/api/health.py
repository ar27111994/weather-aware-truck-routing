"""Health probes: liveness (never touches the database) and readiness (one ``SELECT 1``)."""

from typing import Literal

from django.conf import settings
from django.db import Error as DatabaseError
from django.db import connection
from django.http import HttpRequest
from ninja import Router, Schema

from haulcast import __version__
from haulcast.api.schemas import COMMON_ERRORS, ProblemSchema
from haulcast.problems import ProblemCode, ProblemError

router = Router(tags=["health"])

READINESS_RETRY_AFTER_S = 5.0


class HealthResponse(Schema):
    """Body of ``GET /api/v1/health``."""

    status: Literal["ok"]
    version: str
    commit: str


class ReadyResponse(Schema):
    """Body of ``GET /api/v1/health/ready``."""

    status: Literal["ok"]
    database: Literal["ok"]
    version: str
    commit: str


@router.get(
    "/health",
    response={200: HealthResponse, **COMMON_ERRORS},
    operation_id="getHealth",
    summary="Liveness probe (never touches the database)",
)
def health(request: HttpRequest) -> HealthResponse:
    """Report liveness, the semantic version and the short git SHA of this build."""
    return HealthResponse(status="ok", version=__version__, commit=settings.HAULCAST_COMMIT)


@router.get(
    "/health/ready",
    response={200: ReadyResponse, 503: ProblemSchema, **COMMON_ERRORS},
    operation_id="getReadiness",
    summary="Readiness probe (SELECT 1 through the runtime database role)",
)
def ready(request: HttpRequest) -> ReadyResponse:
    """Report readiness: 200 when the database answers, a 503 problem when it does not."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError as exc:
        raise ProblemError(
            ProblemCode.DATABASE_UNAVAILABLE,
            detail="The database is not reachable.",
            retry_after_s=READINESS_RETRY_AFTER_S,
        ) from exc
    return ReadyResponse(
        status="ok", database="ok", version=__version__, commit=settings.HAULCAST_COMMIT
    )
