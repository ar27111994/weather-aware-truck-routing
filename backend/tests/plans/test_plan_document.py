"""The documents of a plan accept only what their published schema allows (D-24)."""

from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from haulcast.services.plan_document import SCENARIO_IDS, RequestDoc, SourcesDoc

UNKNOWN_SCENARIO = "meteor-strike"


def _request_doc(scenario: str | None) -> dict[str, Any]:
    return {
        "origin": {"lat": 40.7357, "lon": -74.1724, "label": "Newark, New Jersey"},
        "destination": {"lat": 40.7178, "lon": -74.0431, "label": "Jersey City, New Jersey"},
        "departure_time": datetime(2026, 10, 22, 8, 0, tzinfo=UTC),
        "load_weight_lb": 38_000,
        "sampling_interval_mi": 25,
        "scenario": scenario,
    }


def _sources_doc(scenario: str | None) -> dict[str, Any]:
    return {
        "routing": "valhalla",
        "weather": "scenario" if scenario else "open-meteo",
        "weather_model": "best_match",
        "scenario": scenario,
        "attribution": [],
    }


@pytest.mark.parametrize("scenario", [*SCENARIO_IDS, None])
def test_a_document_carries_any_scenario_of_the_catalogue_or_none(scenario: str | None) -> None:
    assert RequestDoc.model_validate(_request_doc(scenario)).scenario == scenario
    assert SourcesDoc.model_validate(_sources_doc(scenario)).scenario == scenario


def test_a_document_refuses_a_scenario_the_catalogue_does_not_have() -> None:
    """The enum is published, so it is enforced: a plan stored under a scenario that was renamed
    since must not be served against a schema that does not list it."""
    with pytest.raises(ValidationError, match="must be one of"):
        RequestDoc.model_validate(_request_doc(UNKNOWN_SCENARIO))
    with pytest.raises(ValidationError, match="must be one of"):
        SourcesDoc.model_validate(_sources_doc(UNKNOWN_SCENARIO))
