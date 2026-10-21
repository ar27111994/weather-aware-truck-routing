"""``GET /api/v1/docs``: the Swagger UI page and the files it needs, from this origin (R2-14)."""

import re
from urllib.parse import urljoin, urlsplit

import pytest
from django.test import Client

DOCS = "/api/v1/docs"
ASSET_URL = re.compile(r'(?:href|src)="([^"]+)"')
CONTENT_TYPES = {
    ".css": "text/css",
    ".js": "text/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

pytestmark = pytest.mark.django_db  # the rate limiter counts every request in Postgres


def _assets_of_the_page(client: Client) -> list[str]:
    """The URLs the page asks the browser for, resolved against the page's own URL."""
    html = client.get(DOCS).content.decode()
    return [urljoin(DOCS, reference) for reference in ASSET_URL.findall(html)]


def test_the_page_loads_nothing_from_another_origin(client: Client) -> None:
    urls = _assets_of_the_page(client)

    assert urls, "the page references no stylesheet or script at all"
    assert all(urlsplit(url).netloc == "" for url in urls), urls


def test_every_file_the_page_asks_for_is_served(client: Client) -> None:
    """Without a ``STATIC_URL`` the page asked for ``/api/v1/ninja/*`` and got 404 three times."""
    urls = _assets_of_the_page(client)

    for url in urls:
        response = client.get(url)
        assert response.status_code == 200, url
        assert response.content, url
        suffix = url[url.rindex(".") :]
        assert response["Content-Type"].startswith(CONTENT_TYPES[suffix]), url


def test_the_files_are_cached_by_the_cdn_and_carry_no_client_headers(client: Client) -> None:
    url = next(url for url in _assets_of_the_page(client) if url.endswith("swagger-ui.css"))

    response = client.get(url)

    assert response["Cache-Control"].startswith("public")
    assert "X-Request-ID" not in response
    assert "RateLimit" not in response


@pytest.mark.parametrize(
    "name",
    ["swagger-ui.css.map", "swagger-ui-bundle.js.map", "redoc.standalone.js", "..", "settings.py"],
)
def test_only_the_files_the_page_uses_are_served(client: Client, name: str) -> None:
    response = client.get(f"/api/v1/docs-assets/ninja/{name}")

    assert response.status_code == 404
    assert response["Content-Type"] == "application/problem+json"


def test_a_head_request_for_a_file_is_answered_without_its_body(client: Client) -> None:
    url = next(url for url in _assets_of_the_page(client) if url.endswith("swagger-ui.css"))

    response = client.head(url)

    assert response.status_code == 200
    assert response.content == b""
    assert int(response["Content-Length"]) > 0


def test_a_file_of_the_page_is_for_reading_only(client: Client) -> None:
    """The view has no business with a body: a POST is refused like it is everywhere else."""
    url = next(url for url in _assets_of_the_page(client) if url.endswith("swagger-ui.css"))

    response = client.post(url, data="{}", content_type="application/json")

    assert response.status_code == 405
    assert response["Content-Type"] == "application/problem+json"
    assert response["Allow"] == "GET, HEAD"
