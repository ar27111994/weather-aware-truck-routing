"""Client identification for rate limiting: a trustworthy IP, reduced to a keyed hash.

Only one source is ever trusted. On Vercel the platform *overwrites* ``x-forwarded-for`` with the
single public client IP, so that header (configured by ``HAULCAST_CLIENT_IP_HEADER``) is exact and
cannot be spoofed or extended by the client. A value that is not exactly one IP literal (a chain
such as ``1.2.3.4, 5.6.7.8``) means the platform did not write it, so it is *ignored*, never parsed
for "the last hop". Without a configured header, or when it holds nothing usable, the socket peer
address is used; if even that is unusable every such request shares one ``unknown`` bucket
(conservative: it can only make limits stricter, never let a client dodge them).

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
    """Return the normalised client IP of ``request``, or :data:`UNKNOWN_CLIENT`."""
    header = settings.HAULCAST_CLIENT_IP_HEADER
    if header is not None:
        trusted = _single_ip(request.headers.get(header))
        if trusted is not None:
            return trusted
    return _single_ip(request.META.get("REMOTE_ADDR")) or UNKNOWN_CLIENT


def client_key(ip: str, salt: str) -> str:
    """Return the stable pseudonymous bucket key of ``ip``: a truncated HMAC-SHA256 hex digest."""
    digest = hmac.new(salt.encode(), ip.encode(), hashlib.sha256).hexdigest()
    return digest[:_KEY_HEX_CHARS]
