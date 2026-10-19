"""The single Django Ninja API instance, mounted at ``/api/v1/`` by the root URLconf."""

from ninja import NinjaAPI

from haulcast import __version__
from haulcast.api.health import router as health_router

api = NinjaAPI(
    title="Haulcast API",
    version=__version__,
    description="Weather-aware truck routing: route options, weather checkpoints and risk.",
    urls_namespace="api-v1",
    openapi_url="/openapi.json",
    docs_url="/docs",
)
api.add_router("", health_router)
