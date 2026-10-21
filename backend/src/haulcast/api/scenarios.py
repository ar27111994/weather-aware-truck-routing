"""``GET /api/v1/scenarios``: the demo weather scenarios (simulated weather, never a forecast)."""

from typing import Final

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema

from haulcast.api.schemas import COMMON_ERRORS
from haulcast.services.container import scenario_catalog
from haulcast.services.plan_document import ScenarioId

router = Router(tags=["reference"])

SCENARIOS_CACHE_CONTROL: Final = (
    "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
)


class ScenarioSummarySchema(Schema):
    """What a scenario picker needs: the id to send back and the words to show."""

    id: ScenarioId
    name: str
    description: str


@router.get(
    "/scenarios",
    response={200: list[ScenarioSummarySchema], **COMMON_ERRORS},
    operation_id="listScenarios",
    summary="Demo weather scenarios (Simulated weather, not a forecast)",
)
def scenarios(request: HttpRequest, response: HttpResponse) -> list[ScenarioSummarySchema]:
    """List the scenarios a plan may name in ``scenario``; real forecasts stay the default."""
    response["Cache-Control"] = SCENARIOS_CACHE_CONTROL
    return [
        ScenarioSummarySchema(id=item.id, name=item.name, description=item.description)
        for item in scenario_catalog().summaries()
    ]
