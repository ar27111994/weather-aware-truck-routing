"""Django settings: every deploy-specific value comes from the environment (12-factor).

This module is deliberately branch-free: parsing and validation live in :mod:`haulcast.config.env`
where they are unit-tested. Importing it never raises for *missing* configuration in a local or CI
environment (tooling such as mypy's Django plugin has to load it); a *deployed* environment (Vercel
production/preview) fails fast at import instead, listing the missing variables by name.
"""

import os

from haulcast.config.env import Config
from haulcast.log import build_logging_config

_CONFIG = Config.from_env(os.environ)
_CONFIG.validate()

DEBUG = _CONFIG.debug
SECRET_KEY = _CONFIG.secret_key
ALLOWED_HOSTS = list(_CONFIG.allowed_hosts)
DATABASES = _CONFIG.django_databases()

HAULCAST_COMMIT = _CONFIG.commit
"""Short git SHA of the running build, reported by ``GET /api/v1/health``."""
HAULCAST_ALLOWED_ORIGINS = _CONFIG.allowed_origins
"""Extra origins (besides the request's own host) allowed to POST: ``https://host[:port]``."""
HAULCAST_RATE_LIMIT_SALT = _CONFIG.rate_limit_salt
"""Key for HMAC-SHA256 hashing of client IPs: raw addresses are never stored."""
HAULCAST_CRON_SECRET = _CONFIG.cron_secret
"""Bearer secret of the maintenance endpoint; ``None`` makes the endpoint answer 404."""
HAULCAST_CLIENT_IP_HEADER = _CONFIG.client_ip_header
"""Platform header that carries the trustworthy client IP (``None``: use the socket address)."""
HAULCAST_TRUCK_TOP_SPEED_KPH = _CONFIG.truck_top_speed_kph
"""Top speed (km/h) sent to the truck routing profile; it changes route ranking."""
HAULCAST_PROVIDER_MODE = _CONFIG.provider_mode
"""``live`` (the public services) or ``replay`` (recorded answers; never in a deployment)."""
HAULCAST_REPLAY_DIR = _CONFIG.replay_dir
"""Directory of the recorded provider answers that replay mode serves."""
HAULCAST_REPLAY_NOW = _CONFIG.replay_now
"""The instant replay mode freezes the wall clock at (UTC); ``None`` in live mode."""

# No admin, sessions, messages, auth or contenttypes: the API is stateless, cookie-free JSON.
# ``ninja`` is listed only because it ships the templates behind the OpenAPI docs UI.
INSTALLED_APPS = ["ninja", "haulcast.store"]
MIDDLEWARE = [
    "haulcast.api.middleware.RequestContextMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "haulcast.api.middleware.RequestGuardMiddleware",
    "haulcast.api.ratelimit.RateLimitMiddleware",
]
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "APP_DIRS": True,
        "OPTIONS": {},
    },
]

ROOT_URLCONF = "haulcast.config.urls"
WSGI_APPLICATION = "haulcast.config.wsgi.application"

STATIC_URL = "/api/v1/docs-assets/"
"""Where the files of the OpenAPI docs page are served (``haulcast.api.docs``, in the URLconf).

Nothing else is a static file: the frontend is a prerendered SPA served by the platform, and the
API serves no uploads, so this is the only ``{% static %}`` user (R2-14).
"""

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
USE_I18N = False

DATA_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024
"""Request bodies above 16 KiB are refused with a 413 problem (no endpoint needs more)."""

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"

LOGGING = build_logging_config()
