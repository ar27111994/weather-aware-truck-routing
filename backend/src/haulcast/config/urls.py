"""Root URL configuration: one Django Ninja API mounted at ``/api/v1/``.

The ``handler*`` hooks make Django's own errors (unknown URL, bad request, crash outside Ninja)
answer with ``problem+json`` like every other error.
"""

from django.urls import path

from haulcast.api.app import api
from haulcast.api.docs import docs_asset

urlpatterns = [
    # The files of the docs page, at the ``STATIC_URL`` of the settings (R2-14).
    path("api/v1/docs-assets/ninja/<str:name>", docs_asset),
    path("api/v1/", api.urls),
]

handler400 = "haulcast.api.errors.bad_request_view"
handler403 = "haulcast.api.errors.permission_denied_view"
handler404 = "haulcast.api.errors.not_found_view"
handler500 = "haulcast.api.errors.server_error_view"
