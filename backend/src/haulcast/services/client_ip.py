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
from typing import Final

from django.conf import settings
from django.http import HttpRequest

UNKNOWN_CLIENT: Final = "unknown"
_IPV6_BUCKET_PREFIX: Final = 64
_KEY_HEX_CHARS: Final = 32


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


def client_ip(request: HttpRequest) -> str:
    """Return the normalised client IP of ``request``, or :data:`UNKNOWN_CLIENT`.

    A configured header decides alone: when it is missing or unusable the answer is
    :data:`UNKNOWN_CLIENT`, never the socket address. Only a deployment without such a header
    reads the socket address.
    """
    header = settings.HAULCAST_CLIENT_IP_HEADER
    source = request.META.get("REMOTE_ADDR") if header is None else request.headers.get(header)
    return _single_ip(source) or UNKNOWN_CLIENT


def client_key(ip: str, salt: str) -> str:
    """Return the stable pseudonymous bucket key of ``ip``: a truncated HMAC-SHA256 hex digest."""
    digest = hmac.new(salt.encode(), ip.encode(), hashlib.sha256).hexdigest()
    return digest[:_KEY_HEX_CHARS]
