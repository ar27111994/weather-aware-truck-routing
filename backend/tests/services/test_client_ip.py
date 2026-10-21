"""Client identification for rate limiting: one trustworthy IP, reduced to a keyed hash."""

import hashlib
import hmac
import logging
from collections.abc import Mapping

import pytest
from django.http import HttpRequest
from django.test import RequestFactory
from hypothesis import given
from hypothesis import strategies as st
from pytest_django import Settings

import haulcast.services.client_ip as client_ip_module
from haulcast.services.client_ip import (
    UNKNOWN_CLIENT,
    UNKNOWN_CLIENT_REPORT_INTERVAL_S,
    IntervalGate,
    client_ip,
    client_key,
)

factory = RequestFactory()


def _request(
    remote_addr: str | None = "198.51.100.1", headers: Mapping[str, str] | None = None
) -> HttpRequest:
    request = factory.get("/", headers=headers)
    if remote_addr is None:
        del request.META["REMOTE_ADDR"]
    else:
        request.META["REMOTE_ADDR"] = remote_addr
    return request


@pytest.fixture
def trusting_xff(settings: Settings) -> None:
    """Trust ``X-Forwarded-For`` the way a Vercel deployment does."""
    settings.HAULCAST_CLIENT_IP_HEADER = "x-forwarded-for"


# --------------------------------------------------------------------------- the socket address


def test_without_a_trusted_header_the_socket_address_is_used() -> None:
    assert client_ip(_request("203.0.113.9")) == "203.0.113.9"


def test_forwarding_headers_are_ignored_unless_one_is_configured() -> None:
    request = _request("203.0.113.9", {"X-Forwarded-For": "192.0.2.77", "X-Real-IP": "192.0.2.78"})

    assert client_ip(request) == "203.0.113.9"


@pytest.mark.parametrize("remote_addr", [None, "", "not-an-ip", "300.1.1.1", "1.2.3", "1.2.3.4.5"])
def test_an_unusable_socket_address_is_the_shared_unknown_bucket(remote_addr: str | None) -> None:
    assert client_ip(_request(remote_addr)) == UNKNOWN_CLIENT


def test_ipv6_clients_share_a_bucket_per_slash_64() -> None:
    first = client_ip(_request("2001:db8:abcd:12:1111:2222:3333:4444"))
    second = client_ip(_request("2001:db8:abcd:12:ffff:eeee:dddd:cccc"))
    other_network = client_ip(_request("2001:db8:abcd:13::1"))

    assert first == second == "2001:db8:abcd:12::"
    assert other_network == "2001:db8:abcd:13::"


def test_ipv4_mapped_ipv6_addresses_are_the_ipv4_address() -> None:
    assert client_ip(_request("::ffff:203.0.113.9")) == "203.0.113.9"


# --------------------------------------------------------------------------- the trusted header


@pytest.mark.usefixtures("trusting_xff")
@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("203.0.113.5", "203.0.113.5"),
        ("  203.0.113.5  ", "203.0.113.5"),
        ("2001:db8::1", "2001:db8::"),
        ("::ffff:203.0.113.5", "203.0.113.5"),
    ],
)
def test_a_single_ip_in_the_trusted_header_wins_over_the_socket_address(
    header: str, expected: str
) -> None:
    assert client_ip(_request("198.51.100.1", {"X-Forwarded-For": header})) == expected


@pytest.mark.usefixtures("trusting_xff")
@pytest.mark.parametrize(
    "header",
    [
        "203.0.113.5, 192.0.2.1",
        "203.0.113.5,192.0.2.1",
        "192.0.2.1, 203.0.113.5",
        "203.0.113.5:8080",
        "unknown",
        "",
        "   ",
        "203.0.113.5; for=x",
        "<script>alert(1)</script>",
    ],
)
def test_anything_but_exactly_one_ip_in_the_trusted_header_is_the_unknown_bucket(
    header: str,
) -> None:
    """A chain, a port, a word, markup or nothing means the platform did not write the header.

    The socket address is not a second opinion: behind the platform it is the platform's own hop
    (or a copy of a forwarded header), so it must not decide who the client is.
    """
    assert client_ip(_request("198.51.100.1", {"X-Forwarded-For": header})) == UNKNOWN_CLIENT


@pytest.mark.usefixtures("trusting_xff")
def test_a_missing_trusted_header_is_the_unknown_bucket_not_the_socket_address() -> None:
    assert client_ip(_request("198.51.100.1")) == UNKNOWN_CLIENT


@pytest.mark.usefixtures("trusting_xff")
def test_a_forwarding_header_that_is_not_the_trusted_one_decides_nothing() -> None:
    request = _request("198.51.100.1", {"X-Real-IP": "192.0.2.50"})

    assert client_ip(request) == UNKNOWN_CLIENT


def test_the_socket_cannot_stand_in_for_the_trusted_header_when_the_runtime_copies_another(
    settings: Settings,
) -> None:
    """Vercel's Python runtime sets REMOTE_ADDR from ``x-forwarded-for``, else ``x-real-ip``.

    (vercel-runtime 0.23.3, ``vc_init.py:1176-1178``.) With ``x-real-ip`` configured and only
    ``x-forwarded-for`` sent, REMOTE_ADDR holds that other header's value: reading it would trust
    a header the deployment did not choose.
    """
    settings.HAULCAST_CLIENT_IP_HEADER = "x-real-ip"

    request = _request("192.0.2.77", {"X-Forwarded-For": "192.0.2.77"})

    assert client_ip(request) == UNKNOWN_CLIENT


def test_any_header_name_can_be_the_trusted_one(settings: Settings) -> None:
    settings.HAULCAST_CLIENT_IP_HEADER = "cf-connecting-ip"

    request = _request("198.51.100.1", {"CF-Connecting-IP": "203.0.113.5"})

    assert client_ip(request) == "203.0.113.5"


# --------------------------------------------------------------------------- the unknown bucket


class StepClock:
    """A monotonic clock that moves only when a test moves it."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> StepClock:
    """The clock of the report gate: no test waits a minute, and none inherits another's gate."""
    step_clock = StepClock()
    gate = IntervalGate(UNKNOWN_CLIENT_REPORT_INTERVAL_S, clock=step_clock)
    monkeypatch.setattr(client_ip_module, "unknown_client_gate", gate)
    return step_clock


def _reports(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == client_ip_module.logger.name]


def test_the_gate_lets_one_event_through_per_interval() -> None:
    step_clock = StepClock()
    gate = IntervalGate(60.0, clock=step_clock)

    first = gate.allow()
    step_clock.now += 59
    early = gate.allow()
    step_clock.now += 1
    due = gate.allow()

    assert (first, early, due) == (True, False, True)


@pytest.mark.usefixtures("trusting_xff")
def test_a_missing_trusted_header_is_reported_by_name_once_a_minute(
    caplog: pytest.LogCaptureFixture, clock: StepClock
) -> None:
    """Every such request shares one bucket: a platform that stops sending the header must show."""
    caplog.set_level(logging.WARNING)

    for _ in range(3):
        client_ip(_request("198.51.100.1"))
    clock.now += UNKNOWN_CLIENT_REPORT_INTERVAL_S
    client_ip(_request("198.51.100.1"))

    reports = _reports(caplog)
    assert len(reports) == 2
    assert "x-forwarded-for" in reports[0].getMessage()
    assert getattr(reports[0], "event", None) == "client_ip_unavailable"


@pytest.mark.usefixtures("trusting_xff", "clock")
def test_the_report_names_the_header_and_never_what_the_client_sent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING)

    client_ip(_request("198.51.100.1", {"X-Forwarded-For": "203.0.113.9, 203.0.113.77"}))

    reports = _reports(caplog)
    assert reports
    everything = " ".join(f"{record.getMessage()} {record.__dict__}" for record in reports)
    for sent in ("203.0.113.9", "203.0.113.77", "198.51.100.1"):
        assert sent not in everything


@pytest.mark.usefixtures("trusting_xff", "clock")
def test_a_usable_trusted_header_reports_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)

    client_ip(_request("198.51.100.1", {"X-Forwarded-For": "203.0.113.9"}))

    assert not _reports(caplog)


@pytest.mark.usefixtures("clock")
def test_a_deployment_without_a_trusted_header_reports_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing sits in front of the process: a bad socket address is not a platform problem."""
    caplog.set_level(logging.WARNING)

    client_ip(_request("not-an-ip"))

    assert not _reports(caplog)


# --------------------------------------------------------------------------- the bucket key


def test_the_key_is_a_truncated_hmac_sha256_of_the_address() -> None:
    expected = hmac.new(b"salt-value", b"203.0.113.5", hashlib.sha256).hexdigest()[:32]

    assert client_key("203.0.113.5", "salt-value") == expected


def test_the_key_is_stable_and_depends_on_both_address_and_salt() -> None:
    assert client_key("203.0.113.5", "a") == client_key("203.0.113.5", "a")
    assert client_key("203.0.113.5", "a") != client_key("203.0.113.6", "a")
    assert client_key("203.0.113.5", "a") != client_key("203.0.113.5", "b")


@given(st.ip_addresses(), st.text(min_size=1, max_size=40))
def test_the_key_never_contains_the_address_and_is_always_32_hex_characters(
    address: object, salt: str
) -> None:
    key = client_key(str(address), salt)

    assert len(key) == 32
    assert all(character in "0123456789abcdef" for character in key)
    assert str(address) not in key
