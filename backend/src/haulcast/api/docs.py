"""The files of the OpenAPI docs page, served from this origin (R2-14).

Django Ninja's docs page (``GET /api/v1/docs``) asks for its stylesheet, scripts and icons through
``{% static %}``. Nothing served them: ``STATIC_URL`` was unset, so the browser asked for
``/api/v1/ninja/...`` and got a 404 for each, and the page stayed blank. The files ship inside the
``ninja`` package. :func:`docs_asset` serves exactly the five the page names from there: an
allow-list, so no path is ever built from the URL, and the page needs neither a third party nor a
static-file server in the deployment.
"""

from pathlib import Path
from typing import Final

import ninja
from django.http import Http404, HttpRequest, HttpResponse

_NINJA_STATIC: Final = Path(ninja.__file__).parent / "static" / "ninja"
_CONTENT_TYPES: Final = {
    "swagger-ui.css": "text/css",
    "swagger-ui-bundle.js": "text/javascript",
    "swagger-ui-init.js": "text/javascript",
    "favicon.svg": "image/svg+xml",
    "favicon.png": "image/png",
}
DOCS_ASSET_CACHE_CONTROL: Final = "public, max-age=86400, s-maxage=604800"
"""The files change only with a Ninja upgrade, so the CDN may keep them for a week."""


def docs_asset(request: HttpRequest, name: str) -> HttpResponse:
    """Return the docs page file called ``name``; any other name is a 404.

    Raises:
        Http404: ``name`` is not one of the files the docs page uses.
    """
    content_type = _CONTENT_TYPES.get(name)
    if content_type is None:
        raise Http404
    response = HttpResponse((_NINJA_STATIC / name).read_bytes(), content_type=content_type)
    response["Cache-Control"] = DOCS_ASSET_CACHE_CONTROL
    return response
