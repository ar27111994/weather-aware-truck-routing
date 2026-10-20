"""``GET /api/v1/rules``: the shared risk-rules document, with a strong ETag and long caching."""

from django.http import HttpRequest, HttpResponse
from django.utils.cache import get_conditional_response
from ninja import Router

from haulcast.api.schemas import COMMON_ERRORS
from haulcast.services.container import rules_document

router = Router(tags=["reference"])

RULES_CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"


@router.get(
    "/rules",
    response={200: dict[str, object], **COMMON_ERRORS},
    operation_id="getRules",
    summary="The risk rules (thresholds and load rules) the application applies",
)
def rules(request: HttpRequest) -> HttpResponse:
    """Serve ``shared/risk-rules.json`` verbatim; ``If-None-Match`` revalidation answers 304."""
    document = rules_document()
    response = HttpResponse(document.body, content_type="application/json")
    response["ETag"] = document.etag
    response["Cache-Control"] = RULES_CACHE_CONTROL
    conditional = get_conditional_response(request, etag=document.etag, response=response)
    return conditional if conditional is not None else response
