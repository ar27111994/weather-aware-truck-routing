"""A throw-away URLconf that makes the API raise every kind of error it must render safely.

The tests mount it in place of the real URLconf (see ``tests/api/conftest.py``) so the real
middleware, the real exception handlers and the real Django error views are exercised by routes that
fail on purpose. Nothing here is imported by production code.
"""

from django.core.exceptions import PermissionDenied, RequestDataTooBig, SuspiciousOperation
from django.http import Http404, HttpRequest, HttpResponse, HttpResponseNotAllowed
from django.urls import path
from ninja import NinjaAPI, Schema
from ninja.errors import HttpError, ValidationError

from haulcast.api.errors import install_exception_handlers
from haulcast.observability import record_cache_outcome, record_upstream_call
from haulcast.problems import FieldError, ProblemError

probe = NinjaAPI(urls_namespace="probe", openapi_url=None, docs_url=None)
install_exception_handlers(probe)

SECRET_DETAIL = "internal-detail-that-must-never-reach-a-client"


class Echo(Schema):
    """Request and response body of the JSON round-trip route."""

    number: int


@probe.get("/ok")
def ok(request: HttpRequest) -> dict[str, bool]:
    """Succeed after recording what the access log summarises."""
    record_upstream_call("probe-upstream", "http_200", 12.34)
    record_cache_outcome("hit")
    record_cache_outcome("miss")
    return {"ok": True}


@probe.get("/ok-no-metrics")
def ok_without_metrics(request: HttpRequest) -> dict[str, bool]:
    """Succeed without any upstream call or cache lookup."""
    return {"ok": True}


@probe.get("/cache-hits")
def cache_hits(request: HttpRequest) -> dict[str, bool]:
    """Succeed after two cache hits (the log summarises them as ``hit``)."""
    record_cache_outcome("hit")
    record_cache_outcome("hit")
    return {"ok": True}


@probe.post("/echo", response=Echo)
def echo(request: HttpRequest, payload: Echo) -> Echo:
    """Round-trip a JSON body through Ninja's parser and validator.

    The body parameter is called ``payload``: the error handler strips that name from validation
    locations (see ``haulcast.api.errors``), so every body-taking endpoint must use it.
    """
    return payload


@probe.get("/problem")
def problem(request: HttpRequest, code: str, retry: float | None = None) -> None:
    """Raise :class:`ProblemError` with an optional ``Retry-After`` hint."""
    raise ProblemError(code, detail="Detail written by our own code.", retry_after_s=retry)


@probe.get("/problem-with-fields")
def problem_with_fields(request: HttpRequest) -> None:
    """Raise a validation problem that carries a field error list."""
    raise ProblemError(
        "validation_error",
        detail="n: bad",
        errors=[FieldError(("query", "n"), "bad", "value_error")],
    )


@probe.get("/not-found")
def not_found(request: HttpRequest) -> None:
    """Raise Django's :class:`Http404` inside Ninja."""
    raise Http404(SECRET_DETAIL)


@probe.get("/too-large")
def too_large(request: HttpRequest) -> None:
    """Raise what Django raises when a body exceeds ``DATA_UPLOAD_MAX_MEMORY_SIZE``."""
    raise RequestDataTooBig(SECRET_DETAIL)


@probe.get("/suspicious")
def suspicious(request: HttpRequest) -> None:
    """Raise Django's :class:`SuspiciousOperation` inside Ninja."""
    raise SuspiciousOperation(SECRET_DETAIL)


@probe.get("/http-error")
def http_error(request: HttpRequest, status: int) -> None:
    """Raise Ninja's :class:`HttpError` with an arbitrary status."""
    raise HttpError(status, SECRET_DETAIL)


@probe.get("/boom")
def boom(request: HttpRequest) -> None:
    """Crash with an exception whose message must never reach a client."""
    raise RuntimeError(SECRET_DETAIL)


@probe.get("/validation/many")
def validation_many(request: HttpRequest) -> None:
    """Raise a validation error with far more entries than the response may list."""
    raise ValidationError(
        [
            {"loc": ("query", f"field{i}"), "msg": f"problem {i}", "type": "value_error"}
            for i in range(25)
        ]
    )


@probe.get("/validation/shapes")
def validation_shapes(request: HttpRequest) -> None:
    """Raise validation errors whose ``loc`` is a list, a tuple, a scalar, mixed or missing."""
    raise ValidationError(
        [
            {"loc": ["body", "payload", "items", 3, "name"], "msg": "m1", "type": "t1"},
            {"loc": ("body", "origin", "lat"), "msg": "m2", "type": "t2"},
            {"loc": "query", "msg": "m3", "type": "t3"},
            {"loc": ("body", True, "x"), "msg": "m4", "type": "t4"},
            {"msg": "m5"},
            {"loc": ("body", "payload"), "type": "t6"},
        ]
    )


@probe.get("/validation/single")
def validation_single(request: HttpRequest) -> None:
    """Raise exactly one validation error."""
    raise ValidationError([{"loc": ("query", "q"), "msg": "too short", "type": "string_too_short"}])


@probe.get("/validation/no-loc")
def validation_without_location(request: HttpRequest) -> None:
    """Raise one validation error that names no field."""
    raise ValidationError([{"loc": (), "msg": "whole body is wrong", "type": "value_error"}])


@probe.get("/validation/none")
def validation_empty(request: HttpRequest) -> None:
    """Raise a validation error that lists nothing."""
    raise ValidationError([])


def django_crash(request: HttpRequest) -> HttpResponse:
    """A plain Django view that crashes outside Ninja (Django's ``handler500`` answers)."""
    raise RuntimeError(SECRET_DETAIL)


def django_suspicious(request: HttpRequest) -> HttpResponse:
    """A plain Django view that raises ``SuspiciousOperation`` (``handler400`` answers)."""
    raise SuspiciousOperation(SECRET_DETAIL)


def django_forbidden(request: HttpRequest) -> HttpResponse:
    """A plain Django view that raises ``PermissionDenied`` (``handler403`` answers)."""
    raise PermissionDenied(SECRET_DETAIL)


def django_method_not_allowed(request: HttpRequest) -> HttpResponse:
    """A bare 405 response that is not ``problem+json`` and names the allowed methods."""
    return HttpResponseNotAllowed(["GET", "HEAD"])


def django_unavailable(request: HttpRequest) -> HttpResponse:
    """A bare 503 response with a ``Retry-After`` hint and a body that must be replaced."""
    response = HttpResponse(SECRET_DETAIL, status=503, content_type="text/plain")
    response["Retry-After"] = "7"
    return response


def django_unauthorized(request: HttpRequest) -> HttpResponse:
    """A bare 401 response that names the authentication scheme it wants."""
    response = HttpResponse(SECRET_DETAIL, status=401, content_type="text/plain")
    response["WWW-Authenticate"] = 'Bearer realm="probe"'
    return response


def django_status(request: HttpRequest, status: int) -> HttpResponse:
    """A bare response with an arbitrary error ``status`` and a body that must be replaced."""
    return HttpResponse(SECRET_DETAIL, status=status, content_type="text/plain")


def django_ok(request: HttpRequest) -> HttpResponse:
    """A response that sets its own ``Cache-Control`` (the middleware must keep it)."""
    response = HttpResponse("fine", content_type="text/plain")
    response["Cache-Control"] = "public, max-age=60"
    return response


urlpatterns = [
    path("probe/", probe.urls),
    path("django/crash", django_crash),
    path("django/suspicious", django_suspicious),
    path("django/forbidden", django_forbidden),
    path("django/method-not-allowed", django_method_not_allowed),
    path("django/unavailable", django_unavailable),
    path("django/unauthorized", django_unauthorized),
    path("django/status/<int:status>", django_status),
    path("django/ok", django_ok),
    path("api/v1/rules", django_ok),
    path("api/v1/openapi.json", django_ok),
]

handler400 = "haulcast.api.errors.bad_request_view"
handler403 = "haulcast.api.errors.permission_denied_view"
handler404 = "haulcast.api.errors.not_found_view"
handler500 = "haulcast.api.errors.server_error_view"
