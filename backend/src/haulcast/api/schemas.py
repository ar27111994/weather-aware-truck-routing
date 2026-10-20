"""OpenAPI-facing schemas shared by every endpoint: the RFC 9457 problem document."""

from typing import Annotated, Final

from ninja import Schema
from pydantic import Field

from haulcast.problems import PROBLEMS


class FieldErrorSchema(Schema):
    """One invalid field of a validation problem."""

    loc: list[str | int]
    msg: str
    type: str


class ProblemSchema(Schema):
    """``application/problem+json`` body of every error response (RFC 9457 plus our extensions)."""

    type: str
    title: str
    status: int
    detail: str | None = None
    code: Annotated[str, Field(json_schema_extra={"enum": list(PROBLEMS)})]
    errors: list[FieldErrorSchema] | None = None
    request_id: str


COMMON_ERRORS: Final = {
    400: ProblemSchema,
    429: ProblemSchema,
    500: ProblemSchema,
}
"""Error responses any endpoint can produce (merged into each operation's ``response=``)."""
