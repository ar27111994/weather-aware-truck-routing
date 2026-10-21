"""Client identification for rate limiting: a trustworthy IP, reduced to a keyed hash.

Only one source is ever trusted, and which one is a fact about the deployment, not about a request:

* Behind a platform proxy it is the header named by ``HAULCAST_CLIENT_IP_HEADER`` (the
  ``CLIENT_IP_HEADER`` variable; ``x-forwarded-for`` on Vercel). Vercel documents that it
  *overwrites* ``x-forwarded-for`` ("to prevent IP spoofing") and that ``x-real-ip`` is identical
  to it (https://vercel.com/docs/headers/request-headers), so the value is exactly one public
  client IP that the client can neither choose nor extend. A value that is not exactly one IP
  literal (a chain such as ``1.2.3.4, 5.6.7.8``) means the platform did not write it, so it is
  *ignored*, never parsed for "the last hop". A request without a usable value shares one
  ``unknown`` bucket (conservative: it can only make limits stricter, never let a client dodge
  them). The socket address (``REMOTE_ADDR``) is **never** consulted here: behind a proxy it is
  the proxy's own hop, and Vercel's Python runtime fills it from ``x-forwarded-for``, else
  ``x-real-ip`` (vercel-runtime 0.23.3, ``vc_init.py:1176-1178``), so reading it would let a
  header the deployment did not choose decide who the client is.
* Without a configured header (local development and tests: nothing sits in front of the process)
  the socket peer address is used, which no client can forge.

IPv6 clients are bucketed by their ``/64`` (one household owns a whole /64, so rotating addresses
inside it must not mint fresh buckets). The bucket key is ``HMAC-SHA256(ip, RATE_LIMIT_SALT)``: raw
addresses are neither stored nor logged.
"""

import hashlib
import hmac
import ipaddress
import logging
import time
from collections.abc import Callable
from typing import Final

from django.conf import settings
from django.http import HttpRequest

logger = logging.getLogger(__name__)

UNKNOWN_CLIENT: Final = "unknown"
UNKNOWN_CLIENT_REPORT_INTERVAL_S: Final = 60.0
"""How often one process says that the trusted client-IP header is missing or unusable."""
_IPV6_BUCKET_PREFIX: Final = 64
_KEY_HEX_CHARS: Final = 32


class IntervalGate:
    """Lets one event through per interval on a monotonic clock: a throttle for a repeated report.

    It keeps no lock. Two threads that arrive in the same instant may both pass, which for a log
    line is harmless.
    """

    def __init__(self, interval_s: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        """Build a gate that is open now and closes for ``interval_s`` seconds after each pass."""
        self._interval_s = interval_s
        self._clock = clock
        self._open_at = float("-inf")

    def allow(self) -> bool:
        """Return whether an event may pass now; a pass closes the gate for one interval."""
        now = self._clock()
        if now < self._open_at:
            return False
        self._open_at = now + self._interval_s
        return True


unknown_client_gate = IntervalGate(UNKNOWN_CLIENT_REPORT_INTERVAL_S)
"""Throttles :func:`_report_unknown_client`; tests replace it with a gate on their own clock."""


def _single_ip(value: str | None) -> str | None:
    """Return ``value`` as a normalised IP literal, or ``None`` unless it is exactly one."""
    if value is None:
        return None
    candidate = value.strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        network = ipaddress.ip_network(f"{address}/{_IPV6_BUCKET_PREFIX}", strict=False)
        return str(network.network_address)
    return str(address)


def _report_unknown_client(header: str) -> None:
    """Say, about once a minute per process, that ``header`` gave no client address.

    Every request without a usable address shares one rate-limit bucket, so a platform that stops
    sending the header would throttle all visitors together with no other sign. The report names
    the header (a setting) and never the value the client sent.
    """
    if unknown_client_gate.allow():
        logger.warning(
            "the client IP header %s is missing or is not a single IP: such requests share one"
            " rate-limit bucket",
            header,
            extra={"event": "client_ip_unavailable"},
        )


def client_ip(request: HttpRequest) -> str:
    """Return the normalised client IP of ``request``, or :data:`UNKNOWN_CLIENT`.

    A configured header decides alone: when it is missing or unusable the answer is
    :data:`UNKNOWN_CLIENT`, never the socket address, and the gap is reported (see
    :func:`_report_unknown_client`). Only a deployment without such a header reads the socket
    address.
    """
    header = settings.HAULCAST_CLIENT_IP_HEADER
    source = request.META.get("REMOTE_ADDR") if header is None else request.headers.get(header)
    address = _single_ip(source)
    if address is not None:
        return address
    if header is not None:
        _report_unknown_client(header)
    return UNKNOWN_CLIENT


def client_key(ip: str, salt: str) -> str:
    """Return the stable pseudonymous bucket key of ``ip``: a truncated HMAC-SHA256 hex digest."""
    digest = hmac.new(salt.encode(), ip.encode(), hashlib.sha256).hexdigest()
    return digest[:_KEY_HEX_CHARS]
