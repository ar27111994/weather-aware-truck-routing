"""WSGI entrypoint, served on Vercel through ``api/index.py``."""

import logging
import os

from django.core.wsgi import get_wsgi_application

from haulcast.config.env import startup_warnings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "haulcast.config.settings")


def report_startup_warnings() -> None:
    """Log the advice :func:`~haulcast.config.env.startup_warnings` has for this environment.

    Called once per cold start, after Django has configured logging, so that the advice reaches
    the platform logs as one structured line instead of a plain line on stderr.
    """
    logger = logging.getLogger("haulcast.config")
    for warning in startup_warnings(os.environ):
        logger.warning(warning)


application = get_wsgi_application()
report_startup_warnings()
