"""No log line of this process carries what a client asked about (D-38).

The geocoding text a visitor types, the coordinates of a trip and the address of an upstream are
request data. Third-party libraries log them without being asked: httpx writes every request it
sends at INFO with its full URL. So this test does not read one logger: it installs the
production ``LOGGING`` setting with its stdout handler pointed at a buffer, sends requests through
the real provider adapters (over ``httpx.MockTransport``, so httpx's own client code runs), and
reads everything the root handler wrote: messages, structured fields and exception text alike.
"""

import io
import json
import logging
import logging.config
from collections.abc import Callable, Iterator, Mapping
from contextlib import redirect_stdout
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from django.conf import settings
from django.test import Client

import haulcast
from haulcast.log import build_logging_config
from haulcast.providers.http import DEFAULT_POLICY, HttpPolicy, build_client
from haulcast.services import container
from tests.plans.support import (
    NEWARK_JERSEY_CITY,
    OPEN_METEO_URL,
    OSRM_URL,
    VALHALLA_URL,
    ApiResponse,
    benign,
    body,
    next_hour,
    recorded,
    weather_response,
)

pytestmark = pytest.mark.django_db

GEOCODE = "/api/v1/geocode"
PLANS = "/api/v1/plans"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
PHOTON_URL = "https://photon.komoot.io/api"

QUERY = "Quillfeather Boulevard 4711"
"""What the visitor types: no real place name, so it cannot appear by chance."""

QUERY_FORMS = (
    QUERY,
    QUERY.replace(" ", "+"),
    QUERY.replace(" ", "%20"),
    "quillfeather",
)
"""The query as typed, as a form value, as a path segment, and its most distinctive word."""

COORDINATES = ("40.7357", "74.1724", "40.7178", "74.0431")
"""Origin and destination of the planned trip (four decimals, as the request carries them)."""

UPSTREAM_HOSTS = tuple(
    httpx.URL(url).host
    for url in (GEOCODING_URL, PHOTON_URL, VALHALLA_URL, OSRM_URL, OPEN_METEO_URL)
)

ROOT = ""
CONFIGURED_LOGGERS = (ROOT, "django.request", "httpx", "httpcore")

Upstream = Callable[[httpx.Request], httpx.Response]


@dataclass(frozen=True)
class Scenario:
    """One request to the API and what the upstreams do while it is served."""

    name: str
    send: Callable[[Client], ApiResponse]
    upstream: Upstream
    status: int
    asks_upstream: bool = True


# --------------------------------------------------------------------------- the harness


@pytest.fixture(autouse=True)
def _fresh_geocoding() -> Iterator[None]:
    """The geocoding service (cache, provider health) is rebuilt for every test."""
    container.geocoding_service.cache_clear()
    yield
    container.geocoding_service.cache_clear()


@pytest.fixture
def production_log() -> Iterator[io.StringIO]:
    """Install the production logging setup; its stdout handler writes into the buffer.

    ``ext://sys.stdout`` is resolved when the configuration is applied, so redirecting stdout for
    that moment makes the real root handler (formatter and levels included) write to the buffer.
    The logging state of the process is put back afterwards.
    """
    assert build_logging_config() == settings.LOGGING, "tests must run on the production setup"
    saved = {
        name: (logger.level, list(logger.handlers), logger.propagate, logger.disabled)
        for name in CONFIGURED_LOGGERS
        for logger in (logging.getLogger(name),)
    }
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        logging.config.dictConfig(settings.LOGGING)
    try:
        yield buffer
    finally:
        for name, (level, handlers, propagate, disabled) in saved.items():
            logger = logging.getLogger(name)
            logger.setLevel(level)
            logger.handlers[:] = handlers
            logger.propagate = propagate
            logger.disabled = disabled


@pytest.fixture
def upstream_calls(monkeypatch: pytest.MonkeyPatch) -> Callable[[Upstream], list[httpx.Request]]:
    """Route every provider client of the container through one ``httpx.MockTransport``."""
    real_build_client = build_client

    def install(upstream: Upstream) -> list[httpx.Request]:
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return upstream(request)

        transport = httpx.MockTransport(handler)

        def build(
            *, headers: Mapping[str, str] | None = None, policy: HttpPolicy = DEFAULT_POLICY
        ) -> httpx.Client:
            return real_build_client(headers=headers, policy=policy, transport=transport)

        monkeypatch.setattr(container, "build_client", build)
        return calls

    return install


def leaks_in(text: str) -> list[str]:
    """What of the request data appears in ``text``, whatever its case."""
    lowered = text.lower()
    found = [f"query as {form!r}" for form in QUERY_FORMS if form.lower() in lowered]
    found += [f"coordinate {value}" for value in COORDINATES if value in text]
    found += [f"upstream host {host}" for host in UPSTREAM_HOSTS if host in lowered]
    return found


# --------------------------------------------------------------------------- upstream scripts


def geocoding_answers(request: httpx.Request) -> httpx.Response:
    """Both geocoders answer with their recorded Denver response."""
    name = "photon-denver.json" if request.url.host == "photon.komoot.io" else "omgeo-denver.json"
    return httpx.Response(200, json=recorded("geocoding", name))


def first_geocoder_is_down(request: httpx.Request) -> httpx.Response:
    """Open-Meteo answers 503 with a body that repeats the query; Photon answers."""
    if request.url.host == "photon.komoot.io":
        return geocoding_answers(request)
    return httpx.Response(503, json={"error": f"no service for {QUERY}"})


def geocoders_are_unreachable(request: httpx.Request) -> httpx.Response:
    """Open-Meteo times out, Photon refuses the connection; both messages hold the URL."""
    if request.url.host == "photon.komoot.io":
        raise httpx.ConnectError(f"connection refused for {request.url}", request=request)
    raise httpx.ReadTimeout(f"timed out reading {request.url}", request=request)


def geocoders_reject_the_request(_request: httpx.Request) -> httpx.Response:
    """Both geocoders answer HTTP 400 and quote the query back, as upstream APIs do."""
    return httpx.Response(400, json={"error": f"cannot parse {QUERY}", "code": 400})


def geocoder_crashes(_request: httpx.Request) -> httpx.Response:
    """A bug below the adapters: an exception no adapter expects (and no layer maps)."""
    raise RuntimeError("the transport failed in a way nobody expected")


def nothing_may_be_asked(request: httpx.Request) -> httpx.Response:
    """A request the API refuses before any upstream is involved."""
    raise AssertionError(f"unexpected upstream call: {request.method} {request.url.host}")


def trip_upstreams(
    *,
    valhalla: Upstream | None = None,
    osrm: Upstream | None = None,
    weather: Upstream | None = None,
) -> Upstream:
    """Valhalla, OSRM and Open-Meteo for the recorded Newark to Jersey City trip."""
    recorded_valhalla = recorded("routing", NEWARK_JERSEY_CITY.valhalla)
    recorded_osrm = recorded("routing", NEWARK_JERSEY_CITY.osrm)

    def answer(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == httpx.URL(VALHALLA_URL).host:
            return valhalla(request) if valhalla else httpx.Response(200, json=recorded_valhalla)
        if host == httpx.URL(OSRM_URL).host:
            return osrm(request) if osrm else httpx.Response(200, json=recorded_osrm)
        return weather(request) if weather else weather_response(request, benign)

    return answer


def refuses_to_connect(request: httpx.Request) -> httpx.Response:
    """The upstream cannot be reached; the library's message names the URL it was asked for."""
    raise httpx.ConnectError(f"connection refused for {request.url}", request=request)


def is_down(request: httpx.Request) -> httpx.Response:
    """The upstream answers 503 and mentions the places it was asked about."""
    return httpx.Response(503, json={"error": f"down; asked {request.url.path}"})


# --------------------------------------------------------------------------- the scenarios


def search(client: Client) -> ApiResponse:
    return client.get(GEOCODE, {"q": QUERY})


def search_far_too_long(client: Client) -> ApiResponse:
    return client.get(GEOCODE, {"q": " ".join([QUERY] * 8)})


def plan(client: Client) -> ApiResponse:
    return client.post(
        PLANS,
        data=body(NEWARK_JERSEY_CITY, next_hour(), interval=10),
        content_type="application/json",
    )


SCENARIOS = (
    Scenario("geocode-found", search, geocoding_answers, 200),
    Scenario("geocode-first-provider-down", search, first_geocoder_is_down, 200),
    Scenario("geocode-every-provider-unreachable", search, geocoders_are_unreachable, 503),
    Scenario("geocode-every-provider-rejects", search, geocoders_reject_the_request, 503),
    Scenario(
        "geocode-invalid-query-422",
        search_far_too_long,
        nothing_may_be_asked,
        422,
        asks_upstream=False,
    ),
    Scenario("geocode-unhandled-error", search, geocoder_crashes, 500),
    Scenario("plan-created", plan, trip_upstreams(), 201),
    Scenario("plan-falls-back-to-osrm", plan, trip_upstreams(valhalla=is_down), 201),
    Scenario(
        "plan-routing-unreachable",
        plan,
        trip_upstreams(valhalla=refuses_to_connect, osrm=refuses_to_connect),
        503,
    ),
    Scenario("plan-weather-unreachable", plan, trip_upstreams(weather=refuses_to_connect), 503),
)


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda scenario: scenario.name)
def test_what_a_client_asked_about_is_in_none_of_the_logs(
    scenario: Scenario,
    client: Client,
    production_log: io.StringIO,
    upstream_calls: Callable[[Upstream], list[httpx.Request]],
) -> None:
    calls = upstream_calls(scenario.upstream)

    response = scenario.send(client)

    written = production_log.getvalue()
    assert response.status_code == scenario.status
    assert bool(calls) is scenario.asks_upstream
    assert '"logger":"haulcast.api.access"' in written, (
        "the root handler saw nothing of the request"
    )
    assert [json.loads(line) for line in written.splitlines()], "every line is a JSON record"
    assert leaks_in(written) == []


def test_the_capture_would_see_an_httpx_request_line(
    client: Client,
    production_log: io.StringIO,
    upstream_calls: Callable[[Upstream], list[httpx.Request]],
) -> None:
    """The harness has teeth: with httpx at INFO the query and the host do reach the buffer."""
    upstream_calls(geocoding_answers)
    logging.getLogger("httpx").setLevel(logging.INFO)

    client.get(GEOCODE, {"q": QUERY})

    leaked = leaks_in(production_log.getvalue())
    assert any(item.startswith("query as") for item in leaked)
    assert any(item.startswith("upstream host") for item in leaked)


def test_no_adapter_raises_an_httpx_status_error() -> None:
    """``raise_for_status`` builds a message with the full URL, which would reach tracebacks."""
    sources = Path(haulcast.__file__).parent.rglob("*.py")

    users = [path.name for path in sources if "raise_for_status" in path.read_text("utf-8")]

    assert users == []
