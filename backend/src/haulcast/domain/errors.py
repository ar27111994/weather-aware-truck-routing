"""Typed domain errors: the API layer maps each ``code`` to a 422 problem response.

Every invalid input the domain can see raises one of these, never a bare ``Exception`` and never an
``assert`` (assertions vanish under ``python -O``).
"""

from collections.abc import Iterable
from typing import ClassVar


class DomainError(Exception):
    """Base class for every error the domain raises on invalid input."""

    code: ClassVar[str] = "domain_error"
    """Stable machine-readable identifier (snake_case) for problem responses."""


class RulesValidationError(DomainError):
    """The risk-rules document breaks its JSON Schema or a semantic invariant.

    ``errors`` lists every problem found (schema errors in a stable, sorted order), so one fix-up
    round can address all of them.
    """

    code: ClassVar[str] = "invalid_rules"

    def __init__(self, errors: Iterable[str]) -> None:
        """Record every problem and summarise them in the message."""
        self.errors: tuple[str, ...] = tuple(errors)
        super().__init__("risk rules are invalid: " + "; ".join(self.errors))


class InvalidLoadError(DomainError):
    """The load weight is not an integer number of pounds inside the rules' load limits."""

    code: ClassVar[str] = "invalid_load"


class InvalidPathError(DomainError):
    """A route path, or a distance along it, breaks the path invariants (DOMAIN-CONTRACT 6)."""

    code: ClassVar[str] = "invalid_path"


class InvalidIntervalError(DomainError):
    """The checkpoint interval is not a positive whole number of miles."""

    code: ClassVar[str] = "invalid_interval"


class InvalidForecastError(DomainError):
    """An hourly forecast series is malformed (start not a UTC hour, ragged or empty arrays)."""

    code: ClassVar[str] = "invalid_forecast"


class NaiveDatetimeError(DomainError):
    """A datetime without a time zone was given where an absolute instant is required."""

    code: ClassVar[str] = "naive_datetime"


class InvalidAssessmentsError(DomainError):
    """Checkpoints and their assessments do not pair up one-to-one."""

    code: ClassVar[str] = "invalid_assessments"


class InvalidCandidatesError(DomainError):
    """The route candidates cannot be ranked (none, duplicate ids, or an invalid duration)."""

    code: ClassVar[str] = "invalid_candidates"
