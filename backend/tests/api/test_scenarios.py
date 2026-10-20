"""``GET /api/v1/scenarios``: the demo weather scenarios a plan request may name."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from django.test import Client

from haulcast.config.paths import SHARED_DIR_VARIABLE
from haulcast.services.container import scenario_catalog

PATH = "/api/v1/scenarios"

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _fresh_catalog() -> Iterator[None]:
    scenario_catalog.cache_clear()
    yield
    scenario_catalog.cache_clear()


def test_the_catalogue_lists_the_demo_scenarios_in_order(client: Client) -> None:
    response = client.get(PATH)

    body = response.json()
    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    assert [item["id"] for item in body] == [
        summary.id for summary in scenario_catalog().summaries()
    ]
    assert {"storm-on-fastest", "high-wind-corridor", "gulf-downpour", "calm"} <= {
        item["id"] for item in body
    }
    assert len(body) >= 4


def test_each_entry_is_just_an_id_and_words(client: Client) -> None:
    for item in client.get(PATH).json():
        assert set(item) == {"id", "name", "description"}
        assert all(isinstance(value, str) and value.strip() for value in item.values())


def test_the_list_is_cacheable_but_not_cross_origin_readable(client: Client) -> None:
    response = client.get(PATH, headers={"Origin": "https://elsewhere.example"})

    assert response["Cache-Control"] == (
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
    )
    assert "Access-Control-Allow-Origin" not in response
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"


def test_a_broken_scenario_directory_is_a_500_problem_that_names_no_path(
    client: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(SHARED_DIR_VARIABLE, str(tmp_path / "missing"))
    scenario_catalog.cache_clear()

    response = client.get(PATH)

    assert response.status_code == 500
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "internal_error"
    assert "missing" not in response.content.decode()
