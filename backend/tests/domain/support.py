"""Shared helpers for the domain tests: the real shared rules document, its schema and builders.

The rules document and schema are read from ``shared/`` once; every caller gets a deep copy so a
test can mutate its document freely without leaking into other tests.
"""

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from haulcast.domain import RiskRules, WeatherSample, load_rules

REPO_ROOT = Path(__file__).resolve().parents[3]
SHARED_DIR = REPO_ROOT / "shared"
RULES_PATH = SHARED_DIR / "risk-rules.json"
SCHEMA_PATH = SHARED_DIR / "risk-rules.schema.json"
FIXTURES_DIR = REPO_ROOT / "backend" / "tests" / "fixtures" / "domain"


def read_json_object(path: Path) -> dict[str, Any]:
    """Read a JSON file that holds an object."""
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return document


_RULES_DOCUMENT = read_json_object(RULES_PATH)
_SCHEMA = read_json_object(SCHEMA_PATH)

RULES: RiskRules = load_rules(_RULES_DOCUMENT, _SCHEMA)
"""The shared rules exactly as both stacks read them."""


def rules_document() -> dict[str, Any]:
    """Return a fresh, freely mutable copy of ``shared/risk-rules.json``."""
    return copy.deepcopy(_RULES_DOCUMENT)


def rules_schema() -> dict[str, Any]:
    """Return a fresh copy of ``shared/risk-rules.schema.json``."""
    return copy.deepcopy(_SCHEMA)


def utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    """Build a tz-aware UTC datetime."""
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


DEFAULT_TIME = utc(2026, 10, 20, 14)


def weather(
    *,
    wind: float | None = 0.0,
    gust: float | None = None,
    rain: float | None = 0.0,
    snow: float | None = 0.0,
) -> WeatherSample:
    """Build a weather sample; every factor defaults to calm, dry and known."""
    return WeatherSample(
        valid_time=DEFAULT_TIME,
        wind_mph=wind,
        gust_mph=gust,
        rain_in_hr=rain,
        snow_in_hr=snow,
        temperature_f=50.0,
        weather_code=0,
    )
