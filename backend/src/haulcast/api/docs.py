"""The files of the OpenAPI docs page, served from this origin (R2-14).

Django Ninja's docs page (``GET /api/v1/docs``) asks for its stylesheet, scripts and icons through
``{% static %}``. Nothing served them: ``STATIC_URL`` was unset, so the browser asked for
``/api/v1/ninja/...`` and got a 404 for each, and the page stayed blank. The files ship inside the
``ninja`` package. :func:`docs_asset` serves exactly the five the page names from there: an
allow-list, so no path is ever built from the URL, and the page needs neither a third party nor a
static-file server in the deployment.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Final

import ninja
from django.http import Http404, HttpRequest, HttpResponse
from django.views.decorators.http import require_safe

_NINJA_STATIC: Final = Path(ninja.__file__).parent / "static" / "ninja"


@dataclass(frozen=True, slots=True)
class _Asset:
    """A file of the docs page: the name its URL carries, where it lies, how it is served."""

    name: str
    path: Path
    content_type: str


def _asset(name: str, content_type: str) -> _Asset:
    return _Asset(name, _NINJA_STATIC / name, content_type)


_ASSETS: Final = (
    _asset("swagger-ui.css", "text/css"),
    _asset("swagger-ui-bundle.js", "text/javascript"),
    _asset("swagger-ui-init.js", "text/javascript"),
    _asset("favicon.svg", "image/svg+xml"),
    _asset("favicon.png", "image/png"),
)
DOCS_ASSET_CACHE_CONTROL: Final = "public, max-age=86400, s-maxage=604800"
"""The files change only with a Ninja upgrade, so the CDN may keep them for a week."""


@require_safe
def docs_asset(request: HttpRequest, name: str) -> HttpResponse:
    """Return the docs page file called ``name``; any other name is a 404, any other method a 405.

    ``name`` is only compared with the names of the allow-list. The file that is read is the
    allow-list's own path, so nothing derived from the URL reaches the file system.

    Raises:
        Http404: ``name`` is not one of the files the docs page uses.
    """
    for asset in _ASSETS:
        if asset.name == name:
            response = HttpResponse(asset.path.read_bytes(), content_type=asset.content_type)
            response["Cache-Control"] = DOCS_ASSET_CACHE_CONTROL
            return response
    raise Http404
