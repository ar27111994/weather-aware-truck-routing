"""Structured JSON logging and the per-request observability state."""

import json
import logging
import threading
from datetime import UTC, datetime, timedelta

import pytest

from haulcast.log import EXTRA_FIELDS, JsonFormatter, build_logging_config
from haulcast.observability import (
    REQUEST_ID_UNSET,
    UpstreamCall,
    begin_request_metrics,
    current_request_id,
    end_request_metrics,
    record_cache_outcome,
    record_upstream_call,
    reset_request_id,
    set_request_id,
)


def _record(message: str = "hello", *args: object, **extra: object) -> logging.LogRecord:
    record = logging.LogRecord("haulcast.test", logging.INFO, __file__, 1, message, args, None)
    record.__dict__.update(extra)
    return record


# --------------------------------------------------------------------------- JSON formatter


def test_a_record_is_one_json_line_with_the_fixed_fields() -> None:
    record = _record("served %s in %d ms", "plan", 12)

    line = JsonFormatter().format(record)

    document = json.loads(line)
    assert "\n" not in line
    assert document["level"] == "INFO"
    assert document["logger"] == "haulcast.test"
    assert document["message"] == "served plan in 12 ms"
    assert document["request_id"] == REQUEST_ID_UNSET
    exact = datetime.fromtimestamp(record.created, UTC)
    assert abs(datetime.fromisoformat(document["ts"]) - exact) < timedelta(milliseconds=1)
    assert document["ts"].endswith("+00:00")


def test_the_current_request_id_is_stamped_on_every_record() -> None:
    token = set_request_id("trace-0003-abcd")
    try:
        document = json.loads(JsonFormatter().format(_record()))
    finally:
        reset_request_id(token)

    assert document["request_id"] == "trace-0003-abcd"


def test_only_allow_listed_extra_fields_are_logged() -> None:
    record = _record(
        event="request",
        method="GET",
        path="/api/v1/health",
        status=200,
        latency_ms=1.5,
        cache="hit",
        upstream=[{"provider": "x", "outcome": "http_200", "ms": 1.0}],
        client_ip="203.0.113.5",
        authorization="Bearer should-never-appear",
    )

    document = json.loads(JsonFormatter().format(record))

    assert set(EXTRA_FIELDS) <= set(document)
    assert "client_ip" not in document
    assert "authorization" not in document
    assert "203.0.113.5" not in json.dumps(document)


def test_values_that_are_not_json_serialisable_are_stringified() -> None:
    document = json.loads(JsonFormatter().format(_record(event=datetime(2026, 10, 20, tzinfo=UTC))))

    assert document["event"].startswith("2026-10-20")


def _explode() -> None:
    raise RuntimeError("boom")


def test_an_exception_is_included_for_operators() -> None:
    try:
        _explode()
    except RuntimeError as error:
        record = _record()
        record.exc_info = (type(error), error, error.__traceback__)

    document = json.loads(JsonFormatter().format(record))

    assert "RuntimeError: boom" in document["exception"]


def test_the_logging_configuration_writes_json_to_stdout_only() -> None:
    config = build_logging_config("WARNING")

    assert config["version"] == 1
    assert config["disable_existing_loggers"] is False
    assert config["formatters"] == {"json": {"()": "haulcast.log.JsonFormatter"}}
    handlers = config["handlers"]
    assert handlers["stdout"]["stream"] == "ext://sys.stdout"
    assert config["root"] == {"handlers": ["stdout"], "level": "WARNING"}
    assert config["loggers"]["django.request"]["propagate"] is False


# --------------------------------------------------------------------------- observability


def test_the_request_id_defaults_outside_a_request_and_resets_after_it() -> None:
    assert current_request_id() == REQUEST_ID_UNSET

    token = set_request_id("trace-0004-abcd")
    assert current_request_id() == "trace-0004-abcd"
    reset_request_id(token)

    assert current_request_id() == REQUEST_ID_UNSET


def test_the_request_id_is_isolated_per_thread() -> None:
    token = set_request_id("trace-0005-abcd")
    seen: list[str] = []
    try:
        thread = threading.Thread(target=lambda: seen.append(current_request_id()))
        thread.start()
        thread.join()
    finally:
        reset_request_id(token)

    assert seen == [REQUEST_ID_UNSET]


def test_metrics_recorded_outside_a_request_are_discarded() -> None:
    record_upstream_call("x", "http_200", 1.0)
    record_cache_outcome("hit")

    tokens = begin_request_metrics()

    assert end_request_metrics(tokens) == ((), ())


def test_metrics_are_collected_between_begin_and_end() -> None:
    tokens = begin_request_metrics()
    record_upstream_call("valhalla", "http_200", 12.5)
    record_upstream_call("osrm", "timeout", 8000.0)
    record_cache_outcome("miss")
    record_cache_outcome("hit")

    calls, outcomes = end_request_metrics(tokens)

    assert calls == (
        UpstreamCall("valhalla", "http_200", 12.5),
        UpstreamCall("osrm", "timeout", 8000.0),
    )
    assert outcomes == ("miss", "hit")


def test_collection_stops_at_end_and_nested_requests_do_not_mix() -> None:
    outer = begin_request_metrics()
    record_cache_outcome("outer-1")
    inner = begin_request_metrics()
    record_cache_outcome("inner")
    assert end_request_metrics(inner) == ((), ("inner",))
    record_cache_outcome("outer-2")

    _, outcomes = end_request_metrics(outer)
    record_cache_outcome("after")

    assert outcomes == ("outer-1", "outer-2")
    assert end_request_metrics(begin_request_metrics()) == ((), ())


@pytest.mark.parametrize("level", ["INFO", "ERROR"])
def test_the_configuration_accepts_any_level(level: str) -> None:
    assert build_logging_config(level)["root"]["level"] == level


@pytest.mark.parametrize("level", ["DEBUG", "INFO", "WARNING", "ERROR"])
def test_the_http_libraries_are_pinned_to_warning_at_every_application_level(level: str) -> None:
    """httpx and httpcore name the URL of every request when they are allowed to speak (D-38)."""
    loggers = build_logging_config(level)["loggers"]

    assert loggers["httpx"]["level"] == "WARNING"
    assert loggers["httpcore"]["level"] == "WARNING"
