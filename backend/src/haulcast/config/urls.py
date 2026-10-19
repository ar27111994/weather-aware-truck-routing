"""Root URL configuration: one Django Ninja API mounted at ``/api/v1/``."""

from django.urls import path

from haulcast.api.app import api

urlpatterns = [path("api/v1/", api.urls)]
