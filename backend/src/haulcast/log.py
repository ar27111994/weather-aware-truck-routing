"""Structured JSON logging: one JSON object per line on stdout, which Vercel collects as-is.

Records carry the request id of the request being served (see :mod:`haulcast.observability`) and a
fixed allow-list of structured fields. Client addresses, query strings, request bodies and secrets
are never logged: the access log records the path only, no log call in the code base passes
anything else, and the HTTP client libraries, which would log every URL they fetch (places and
coordinates), are held at WARNING whatever the application level is (D-38).
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any, Final

from haulcast.observability import current_request_id

EXTRA_FIELDS: Final = ("event", "method", "path", "status", "latency_ms", "cache", "upstream")
"""Structured fields a log call may attach with ``extra={...}``; anything else is dropped."""


class JsonFormatter(logging.Formatter):
    """Render a :class:`logging.LogRecord` as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        """Return the JSON line for ``record``: time, level, logger, message, request id, extras."""
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": current_request_id(),
        }
        for name in EXTRA_FIELDS:
            if hasattr(record, name):
                payload[name] = getattr(record, name)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, separators=(",", ":"), default=str)


def build_logging_config(level: str = "INFO") -> dict[str, Any]:
    """Return the Django ``LOGGING`` setting: every logger writes JSON lines to stdout."""
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"json": {"()": "haulcast.log.JsonFormatter"}},
        "handlers": {
            "stdout": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
                "formatter": "json",
            },
        },
        "root": {"handlers": ["stdout"], "level": level},
        "loggers": {
            # Django logs every 4xx/5xx at request level itself; the access log already covers it.
            "django.request": {"handlers": ["stdout"], "level": "ERROR", "propagate": False},
            # httpx logs every request it sends at INFO, URL included; ours name places and trips.
            "httpx": {"level": "WARNING"},
            "httpcore": {"level": "WARNING"},
        },
    }
