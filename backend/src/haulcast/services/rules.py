"""The risk-rules document served by ``GET /api/v1/rules`` (and its validators).

``shared/risk-rules.json`` is the single source of truth for thresholds and load rules, read by the
domain, the methodology page and this endpoint. The endpoint serves the file's exact bytes with a
strong content-hash ETag, so the CDN and browsers revalidate for free and a changed rule changes the
ETag. The document is validated for *shape* (a JSON object) here; its *semantics* are
validated by the domain's rules loader, the only component allowed to interpret it.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from haulcast.config.paths import shared_dir

RULES_FILENAME = "risk-rules.json"


class RulesDocumentError(RuntimeError):
    """``shared/risk-rules.json`` is missing or is not a JSON object."""


@dataclass(frozen=True, slots=True)
class RulesDocument:
    """The raw bytes of the rules file and their strong ETag (a quoted SHA-256 prefix)."""

    body: bytes
    etag: str


def load_rules_document(path: Path | None = None) -> RulesDocument:
    """Read ``path`` (default ``shared/risk-rules.json``) and compute its ETag.

    Raises:
        RulesDocumentError: the file cannot be read or does not hold a JSON object.
    """
    location = path if path is not None else shared_dir() / RULES_FILENAME
    try:
        body = location.read_bytes()
        document = json.loads(body)
    except (OSError, ValueError) as exc:
        raise RulesDocumentError(f"cannot load {location.name}") from exc
    if not isinstance(document, dict):
        raise RulesDocumentError(f"{location.name} must contain a JSON object")
    return RulesDocument(body=body, etag=f'"{hashlib.sha256(body).hexdigest()[:32]}"')
