"""Vercel Python entrypoint: expose Django's WSGI application as ``app``.

Vercel runs this file as the single serverless function behind ``/api/*``. The Django project lives
in ``backend/src`` (outside the function root), so it is added to ``sys.path`` before the import.
"""

import importlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "src"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "haulcast.config.settings")

app = importlib.import_module("haulcast.config.wsgi").application
