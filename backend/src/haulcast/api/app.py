"""The single Django Ninja API instance, mounted at ``/api/v1/`` by the root URLconf.

Every error leaves this API as ``application/problem+json`` (:mod:`haulcast.api.errors`); the
OpenAPI document describes those responses with the same schema so generated clients type them.
"""

from ninja import NinjaAPI

from haulcast import __version__
from haulcast.api.errors import install_exception_handlers
from haulcast.api.health import router as health_router
from haulcast.api.maintenance import router as maintenance_router
from haulcast.api.rules import router as rules_router

api = NinjaAPI(
    title="Haulcast API",
    version=__version__,
    description="Weather-aware truck routing: route options, weather checkpoints and risk.",
    urls_namespace="api-v1",
    openapi_url="/openapi.json",
    docs_url="/docs",
)
install_exception_handlers(api)
api.add_router("", health_router)
api.add_router("", rules_router)
api.add_router("", maintenance_router)
