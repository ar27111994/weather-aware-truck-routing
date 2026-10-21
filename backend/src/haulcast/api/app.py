"""The single Django Ninja API instance, mounted at ``/api/v1/`` by the root URLconf.

Every error leaves this API as ``application/problem+json`` (:mod:`haulcast.api.errors`); the
OpenAPI document describes those responses with the same schema so generated clients type them.
"""

from typing import Any

from ninja import NinjaAPI
from ninja.openapi.schema import OpenAPISchema
from ninja.types import DictStrAny

from haulcast import __version__
from haulcast.api.errors import install_exception_handlers
from haulcast.api.geocode import router as geocode_router
from haulcast.api.health import router as health_router
from haulcast.api.maintenance import router as maintenance_router
from haulcast.api.plans import router as plans_router
from haulcast.api.rules import router as rules_router
from haulcast.api.scenarios import router as scenarios_router
from haulcast.problems import PROBLEM_MEDIA_TYPE

_FIRST_ERROR_STATUS = 400
_JSON_MEDIA_TYPE = "application/json"


def declare_problem_media_type(schema: dict[str, Any]) -> None:
    """Re-declare every documented error response as ``application/problem+json`` (R2-15).

    Ninja files each response under the renderer's media type, ``application/json``. Errors are
    served as RFC 9457 problem documents, so typed clients and contract tests have to be told that
    media type, not the success one. Only error statuses are touched, and only their content.
    """
    for item in schema["paths"].values():
        for operation in item.values():
            for status, response in operation["responses"].items():
                content = response.get("content", {})
                is_error = str(status).isdigit() and int(status) >= _FIRST_ERROR_STATUS
                if is_error and _JSON_MEDIA_TYPE in content:
                    response["content"] = {PROBLEM_MEDIA_TYPE: content[_JSON_MEDIA_TYPE]}


class HaulcastAPI(NinjaAPI):
    """The API, whose OpenAPI document names the media type its errors are served with."""

    def get_openapi_schema(
        self,
        *,
        path_prefix: str | None = None,
        path_params: DictStrAny | None = None,
    ) -> OpenAPISchema:
        """Return Ninja's document with the error responses declared as problem documents."""
        schema = super().get_openapi_schema(path_prefix=path_prefix, path_params=path_params)
        declare_problem_media_type(schema)
        return schema


api = HaulcastAPI(
    title="Haulcast API",
    version=__version__,
    description="Weather-aware truck routing: route options, weather checkpoints and risk.",
    urls_namespace="api-v1",
    openapi_url="/openapi.json",
    docs_url="/docs",
)
install_exception_handlers(api)
api.add_router("", health_router)
api.add_router("", geocode_router)
api.add_router("", rules_router)
api.add_router("", scenarios_router)
api.add_router("", plans_router)
api.add_router("", maintenance_router)
