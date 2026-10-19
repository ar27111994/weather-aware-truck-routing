"""WSGI entrypoint, served on Vercel through ``api/index.py``."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "haulcast.config.settings")

application = get_wsgi_application()
