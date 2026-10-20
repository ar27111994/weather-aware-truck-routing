"""``GET /api/v1/rules``: the shared risk-rules document with a strong ETag and long caching."""

import hashlib
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from django.test import Client

from haulcast.api.rules import RULES_CACHE_CONTROL
from haulcast.config.paths import SHARED_DIR_VARIABLE, shared_dir
from haulcast.services.container import rules_document

PATH = "/api/v1/rules"

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _fresh_rules_document() -> Iterator[None]:
    """The accessor caches per process: start and finish each test from a cold cache."""
    rules_document.cache_clear()
    yield
    rules_document.cache_clear()


def test_the_document_is_served_verbatim(client: Client) -> None:
    response = client.get(PATH)

    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response.content == (shared_dir() / "risk-rules.json").read_bytes()


def test_the_etag_is_a_strong_content_hash(client: Client) -> None:
    response = client.get(PATH)

    etag = response["ETag"]
    assert re.fullmatch(r'"[0-9a-f]{32}"', etag)
    assert etag == f'"{hashlib.sha256(response.content).hexdigest()[:32]}"'


def test_the_document_is_cacheable_for_a_day_by_browsers_and_a_week_by_the_cdn(
    client: Client,
) -> None:
    response = client.get(PATH)

    assert response["Cache-Control"] == RULES_CACHE_CONTROL
    assert RULES_CACHE_CONTROL == (
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"
    )


def test_it_is_one_of_the_two_documents_other_origins_may_read(client: Client) -> None:
    response = client.get(PATH, headers={"Origin": "https://elsewhere.example"})

    assert response["Access-Control-Allow-Origin"] == "*"
    assert response["Cross-Origin-Resource-Policy"] == "cross-origin"


def test_a_head_request_describes_the_same_document(client: Client) -> None:
    get = client.get(PATH)
    head = client.head(PATH)

    assert head.status_code == 200
    assert head.content == b""
    assert head["ETag"] == get["ETag"]
    assert head["Cache-Control"] == get["Cache-Control"]
    assert head["Content-Length"] == str(len(get.content))
    assert head["Access-Control-Allow-Origin"] == "*"


def test_a_head_request_revalidates_like_its_get(client: Client) -> None:
    etag = client.get(PATH)["ETag"]

    response = client.head(PATH, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""


def test_a_matching_if_none_match_is_answered_with_an_empty_304(client: Client) -> None:
    etag = client.get(PATH)["ETag"]

    response = client.get(PATH, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""
    assert response["ETag"] == etag
    assert response["Cache-Control"] == RULES_CACHE_CONTROL
    assert response["Access-Control-Allow-Origin"] == "*"


@pytest.mark.parametrize("form", ["{etag}", "W/{etag}", '"other", {etag}', "*"])
def test_every_if_none_match_form_that_names_the_current_version_revalidates(
    client: Client, form: str
) -> None:
    etag = client.get(PATH)["ETag"]

    response = client.get(PATH, headers={"If-None-Match": form.format(etag=etag)})

    assert response.status_code == 304


@pytest.mark.parametrize("header", ['"0123456789abcdef0123456789abcdef"', '"a", "b"', ""])
def test_a_stale_validator_gets_the_full_document(client: Client, header: str) -> None:
    response = client.get(PATH, headers={"If-None-Match": header})

    assert response.status_code == 200
    assert response.content


def test_the_etag_tracks_the_content_of_the_file(
    client: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = client.get(PATH)["ETag"]
    (tmp_path / "risk-rules.json").write_text('{"version": 2}', encoding="utf-8")
    monkeypatch.setenv(SHARED_DIR_VARIABLE, str(tmp_path))
    rules_document.cache_clear()

    changed = client.get(PATH)

    assert changed.json() == {"version": 2}
    assert changed["ETag"] != original


def test_a_missing_document_is_a_500_problem_that_does_not_name_paths(
    client: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(SHARED_DIR_VARIABLE, str(tmp_path / "nowhere"))
    rules_document.cache_clear()

    response = client.get(PATH)

    assert response.status_code == 500
    assert response["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "internal_error"
    assert "nowhere" not in response.content.decode()
