"""Root URL configuration: one Django Ninja API mounted at ``/api/v1/``.

The ``handler*`` hooks make Django's own errors (unknown URL, bad request, crash outside Ninja)
answer with ``problem+json`` like every other error.
"""

from django.urls import path

from haulcast.api.app import api

urlpatterns = [path("api/v1/", api.urls)]

handler400 = "haulcast.api.errors.bad_request_view"
handler403 = "haulcast.api.errors.permission_denied_view"
handler404 = "haulcast.api.errors.not_found_view"
handler500 = "haulcast.api.errors.server_error_view"
