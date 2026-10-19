"""Django settings: every deploy-specific value comes from the environment (12-factor).

This module is deliberately branch-free: parsing and validation live in :mod:`haulcast.config.env`
where they are unit-tested. Importing it never raises for *missing* configuration (tooling such as
mypy's Django plugin has to load it); absent values take fail-closed defaults instead.
"""

import os

from haulcast.config.env import Config

_CONFIG = Config.from_env(os.environ)

DEBUG = _CONFIG.debug
SECRET_KEY = _CONFIG.secret_key
ALLOWED_HOSTS = list(_CONFIG.allowed_hosts)
DATABASES = _CONFIG.django_databases()

HAULCAST_COMMIT = _CONFIG.commit
"""Short git SHA of the running build, reported by ``GET /api/v1/health``."""

# No admin, sessions, messages, auth or contenttypes: the API is stateless, cookie-free JSON.
# ``ninja`` is listed only because it ships the templates behind the OpenAPI docs UI.
INSTALLED_APPS = ["ninja", "haulcast.store"]
MIDDLEWARE = ["django.middleware.security.SecurityMiddleware"]
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "APP_DIRS": True,
        "OPTIONS": {},
    },
]

ROOT_URLCONF = "haulcast.config.urls"
WSGI_APPLICATION = "haulcast.config.wsgi.application"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
USE_I18N = False

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
