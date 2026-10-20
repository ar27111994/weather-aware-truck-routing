"""Rendering of every error as RFC 9457 ``application/problem+json``, with no exceptions.

Three paths lead here and all produce the same document shape:

* Django Ninja operations: the handlers installed by :func:`install_exception_handlers` (including a
  catch-all, so Ninja's debug-mode traceback page can never reach a client);
* Django itself (unknown URLs, bad hosts, crashes outside Ninja): the ``handler4xx``/``handler500``
  views referenced from the root URLconf;
* anything else that produced an error response (for example a bare 405): the outermost middleware
  calls :func:`normalize_error_response`.

A response never contains a stack trace, an upstream's raw error or a secret: the only free text is
the ``detail`` chosen by our own code.
"""

import json
import logging
import math
from collections.abc import Callable
from typing import Final, cast

from django.conf import settings
from django.core.exceptions import RequestDataTooBig, SuspiciousOperation
from django.http import Http404, HttpRequest, HttpResponse
from ninja import NinjaAPI
from ninja.errors import HttpError, ValidationError

from haulcast.observability import current_request_id
from haulcast.problems import (
    FALLBACK_BY_STATUS,
    PROBLEM_MEDIA_TYPE,
    FieldError,
    ProblemError,
    document_for,
)

logger = logging.getLogger("haulcast.api")

MAX_REPORTED_FIELD_ERRORS: Final = 20
"""Validation problems list at most this many field errors (bounds the response size)."""

_PRESERVED_HEADERS: Final = ("Allow", "Retry-After", "WWW-Authenticate")
_BODY_PREFIX: Final = ("body", "payload")
_PARSE_ERROR_MESSAGE: Final = "Cannot parse request body"
_MIN_CLIENT_ERROR_STATUS: Final = 400
_MIN_SERVER_ERROR_STATUS: Final = 500
_BYTES_PER_KIB: Final = 1024


def render_problem(error: ProblemError) -> HttpResponse:
    """Serialise ``error`` as a ``problem+json`` response (``no-store``, plus ``Retry-After``)."""
    document = document_for(error, current_request_id())
    response = HttpResponse(
        json.dumps(document.to_json_object(), separators=(",", ":")),
        status=error.status,
        content_type=PROBLEM_MEDIA_TYPE,
    )
    response["Cache-Control"] = "no-store"
    if error.retry_after_s is not None:
        response["Retry-After"] = str(max(1, math.ceil(error.retry_after_s)))
    return response


def problem_for_status(status: int) -> ProblemError:
    """Return the generic :class:`ProblemError` for a response that only carries a ``status``."""
    code = FALLBACK_BY_STATUS.get(status)
    if code is not None:
        return ProblemError(code)
    if status >= _MIN_SERVER_ERROR_STATUS:
        return ProblemError("internal_error", status=status)
    return ProblemError("bad_request", status=status)


def payload_too_large() -> ProblemError:
    """Return the 413 problem naming the configured body limit."""
    limit_kib = settings.DATA_UPLOAD_MAX_MEMORY_SIZE // _BYTES_PER_KIB
    return ProblemError("payload_too_large", detail=f"The request body exceeds {limit_kib} KiB.")


def normalize_error_response(response: HttpResponse) -> HttpResponse:
    """Rewrite an error response that is not ``problem+json`` into one, keeping routing headers."""
    rewritten = render_problem(problem_for_status(response.status_code))
    for name in _PRESERVED_HEADERS:
        if name in response:
            rewritten[name] = response[name]
    return rewritten


def is_problem(response: HttpResponse) -> bool:
    """Return whether ``response`` already is a ``problem+json`` document."""
    return response.headers.get("Content-Type", "").split(";", 1)[0].strip() == PROBLEM_MEDIA_TYPE


def _field_errors(raw_errors: list[dict[str, object]]) -> tuple[FieldError, ...]:
    """Convert Ninja/Pydantic error dicts to :class:`FieldError`, dropping input and context."""
    converted: list[FieldError] = []
    for raw in raw_errors[:MAX_REPORTED_FIELD_ERRORS]:
        raw_loc = raw.get("loc", ())
        loc = tuple(
            part if isinstance(part, int) and not isinstance(part, bool) else str(part)
            for part in (raw_loc if isinstance(raw_loc, tuple | list) else (raw_loc,))
        )
        # Ninja inserts the *parameter name* of a body model right after ``body``; clients address
        # the field itself (``["body", "departure_time"]``), so the parameter name is dropped.
        if loc[: len(_BODY_PREFIX)] == _BODY_PREFIX and len(loc) > len(_BODY_PREFIX):
            loc = (_BODY_PREFIX[0], *loc[len(_BODY_PREFIX) :])
        converted.append(
            FieldError(
                loc=loc, msg=str(raw.get("msg", "Invalid value")), type=str(raw.get("type", ""))
            )
        )
    return tuple(converted)


def _validation_detail(errors: tuple[FieldError, ...], total: int) -> str:
    """Summarise validation errors in one sentence for the problem's ``detail``."""
    first = errors[0]
    field_path = ".".join(str(part) for part in first.loc[1:])
    summary = f"{field_path}: {first.msg}" if field_path else first.msg
    return summary if total == 1 else f"{summary} (and {total - 1} more)"


def _handle_problem(request: HttpRequest, exc: ProblemError) -> HttpResponse:
    return render_problem(exc)


def _handle_validation(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    errors = _field_errors(exc.errors)
    detail = _validation_detail(errors, len(exc.errors)) if errors else None
    return render_problem(ProblemError("validation_error", detail=detail, errors=errors))


def _handle_http_error(request: HttpRequest, exc: HttpError) -> HttpResponse:
    if exc.status_code == _MIN_CLIENT_ERROR_STATUS and exc.message == _PARSE_ERROR_MESSAGE:
        return render_problem(
            ProblemError("malformed_json", detail="The request body is not valid JSON.")
        )
    return render_problem(problem_for_status(exc.status_code))


def _handle_not_found(request: HttpRequest, exc: Http404) -> HttpResponse:
    return render_problem(ProblemError("not_found"))


def _handle_too_large(request: HttpRequest, exc: RequestDataTooBig) -> HttpResponse:
    return render_problem(payload_too_large())


def _handle_suspicious(request: HttpRequest, exc: SuspiciousOperation) -> HttpResponse:
    return render_problem(ProblemError("bad_request"))


def _handle_unexpected(request: HttpRequest, exc: Exception) -> HttpResponse:
    logger.error("unhandled_exception", exc_info=exc)
    return render_problem(ProblemError("internal_error"))


def _register[E: Exception](
    api: NinjaAPI,
    exception_class: type[E],
    handler: Callable[[HttpRequest, E], HttpResponse],
) -> None:
    """Register ``handler`` for ``exception_class``, narrowing Ninja's ``E | type[E]`` argument.

    Ninja annotates the exception it passes as ``E | type[E]`` but always passes an instance.
    """

    def adapter(request: HttpRequest, exc: E | type[E]) -> HttpResponse:
        return handler(request, cast("E", exc))

    api.add_exception_handler(exception_class, adapter)


def install_exception_handlers(api: NinjaAPI) -> None:
    """Register the problem+json handlers on ``api`` (the most specific class wins, by MRO)."""
    _register(api, Exception, _handle_unexpected)
    _register(api, ProblemError, _handle_problem)
    _register(api, ValidationError, _handle_validation)
    _register(api, HttpError, _handle_http_error)
    _register(api, Http404, _handle_not_found)
    _register(api, RequestDataTooBig, _handle_too_large)
    _register(api, SuspiciousOperation, _handle_suspicious)


def bad_request_view(request: HttpRequest, exception: Exception) -> HttpResponse:
    """Django ``handler400``: malformed requests and suspicious operations (such as a bad Host)."""
    return render_problem(ProblemError("bad_request"))


def permission_denied_view(request: HttpRequest, exception: Exception) -> HttpResponse:
    """Django ``handler403``."""
    return render_problem(ProblemError("forbidden"))


def not_found_view(request: HttpRequest, exception: Exception) -> HttpResponse:
    """Django ``handler404``: no URL pattern matched."""
    return render_problem(ProblemError("not_found"))


def server_error_view(request: HttpRequest) -> HttpResponse:
    """Django ``handler500``: an unexpected crash outside Ninja."""
    return render_problem(ProblemError("internal_error"))
