"""Golden plans and heatmaps: deterministic scenario weather, recorded routes, reviewed snapshots.

Scenario weather is synthetic and deterministic, the routes are T1's recorded provider answers, the
clock and the plan ids are fixed: the whole plan and heatmap JSON is a pure function of the inputs.
The short Newark trip is snapshotted in full (geometry and every heatmap array). For the long
trips the bulky arrays (polyline, cumulative values, the 49 x cells x 5 field arrays) are replaced
by count, first, last and a SHA-256, plus a per-frame risk histogram, so the snapshot stays small
enough to review while still changing whenever any single number does.
"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

import pytest
import respx
from django.test import Client
from syrupy.assertion import SnapshotAssertion
from syrupy.extensions.json import JSONSnapshotExtension

import haulcast.api.plans as plans_api
from haulcast.services import container
from haulcast.services.container import risk_rules, scenario_catalog
from haulcast.services.heatmap_service import HeatmapService
from haulcast.services.plan_service import PlanService
from tests.plans.fakes import runtime
from tests.plans.support import (
    CHICAGO_DENVER,
    NEWARK_JERSEY_CITY,
    PLANS,
    SLC_DENVER,
    Trip,
    body,
    mock_routing,
)

pytestmark = pytest.mark.django_db

DEPARTURE = datetime(2026, 10, 20, 14, 0, tzinfo=UTC)


@pytest.fixture
def snapshot_json(snapshot: SnapshotAssertion) -> SnapshotAssertion:
    return snapshot.use_extension(JSONSnapshotExtension)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, upstream: respx.MockRouter) -> None:
    """Recorded routes through the real chain; a fixed clock and fixed ids."""
    mock_routing(upstream, SLC_DENVER, CHICAGO_DENVER, NEWARK_JERSEY_CITY)
    fixed = runtime()
    plans = PlanService(
        container.routing_service(),
        container.weather_service(),
        scenario_catalog(),
        risk_rules(),
        fixed,
    )
    heatmaps = HeatmapService(container.weather_service(), scenario_catalog(), risk_rules(), fixed)
    monkeypatch.setattr(plans_api, "plan_service", lambda: plans)
    monkeypatch.setattr(plans_api, "heatmap_service", lambda: heatmaps)


def array_digest(values: list[Any]) -> dict[str, Any]:
    text = json.dumps(values, separators=(",", ":")).encode()
    return {
        "count": len(values),
        "first": values[0],
        "last": values[-1],
        "sha256": hashlib.sha256(text).hexdigest(),
    }


def plan_digest(plan: dict[str, Any]) -> dict[str, Any]:
    digest: dict[str, Any] = json.loads(json.dumps(plan))
    for route in digest["routes"]:
        route["geometry"]["coordinates"] = array_digest(route["geometry"]["coordinates"])
        route["cumulative_mi"] = array_digest(route["cumulative_mi"])
        route["cumulative_s"] = array_digest(route["cumulative_s"])
    return digest


def heatmap_digest(document: dict[str, Any]) -> dict[str, Any]:
    cells = len(document["cells"])
    risk = document["fields"]["risk"]
    histogram = [
        {
            str(level): count
            for level in range(-1, 5)
            if (count := risk[frame * cells : (frame + 1) * cells].count(level))
        }
        for frame in range(document["frame_count"])
    ]
    digest = {key: value for key, value in document.items() if key != "fields"}
    digest["risk_histogram_by_frame"] = histogram
    digest["field_digests"] = {
        name: array_digest(values) for name, values in document["fields"].items()
    }
    return digest


def create(client: Client, trip: Trip, scenario: str, interval: int) -> dict[str, Any]:
    response = client.post(
        PLANS,
        data=body(trip, DEPARTURE, interval=interval, scenario=scenario),
        content_type="application/json",
    )
    assert response.status_code == 201
    plan: dict[str, Any] = response.json()
    return plan


@pytest.mark.usefixtures("wired")
def test_short_trip_plan_matches_the_reviewed_snapshot(
    client: Client, snapshot_json: SnapshotAssertion
) -> None:
    plan = create(client, NEWARK_JERSEY_CITY, "storm-on-fastest", interval=10)

    assert plan == snapshot_json


@pytest.mark.usefixtures("wired")
def test_short_trip_heatmap_matches_the_reviewed_snapshot(
    client: Client, snapshot_json: SnapshotAssertion
) -> None:
    plan = create(client, NEWARK_JERSEY_CITY, "storm-on-fastest", interval=10)

    heatmap = client.get(f"/api/v1/plans/{plan['plan_id']}/heatmap").json()

    assert heatmap == snapshot_json


@pytest.mark.usefixtures("wired")
@pytest.mark.parametrize(
    ("trip", "scenario", "interval"),
    [
        pytest.param(SLC_DENVER, "high-wind-corridor", 25, id="medium-high-wind"),
        pytest.param(CHICAGO_DENVER, "gulf-downpour", 50, id="long-downpour"),
    ],
)
def test_long_trip_plans_and_heatmaps_match_the_reviewed_snapshots(
    client: Client, snapshot_json: SnapshotAssertion, trip: Trip, scenario: str, interval: int
) -> None:
    plan = create(client, trip, scenario, interval)

    heatmap = client.get(f"/api/v1/plans/{plan['plan_id']}/heatmap").json()

    assert {"plan": plan_digest(plan), "heatmap": heatmap_digest(heatmap)} == snapshot_json
