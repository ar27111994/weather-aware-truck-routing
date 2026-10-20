"""Process-wide wiring: the production collaborators of the API, built once and cached.

Endpoints depend on these accessor functions, never on provider classes, so tests swap a
collaborator by clearing the accessor's cache (``accessor.cache_clear()``) and monkeypatching
where needed. Every accessor builds from constants and settings only: no request-controlled
value ever reaches a URL.
"""

from functools import cache

from haulcast.services.rules import RulesDocument, load_rules_document


@cache
def rules_document() -> RulesDocument:
    """The ``shared/risk-rules.json`` document and its ETag (read once per process)."""
    return load_rules_document()
