"""Rate-limit middleware: one decision per request, IETF ``RateLimit`` headers, 429 problems.

The decision itself is made by :mod:`haulcast.services.ratelimit`; this layer only identifies the
client (a keyed hash of its IP), looks up the endpoint's rule and renders the outcome:

* allowed requests continue and their response carries ``RateLimit-Policy`` and ``RateLimit``
  (draft-ietf-httpapi-ratelimit-headers: ``"minute";q=6;w=60`` and ``"minute";r=5;t=10``);
* refused requests get a ``429`` ``problem+json`` with ``Retry-After`` and the same headers for the
  bucket that refused.
"""

import math
from collections.abc import Callable, Sequence

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from haulcast.api.errors import render_problem
from haulcast.problems import ProblemError
from haulcast.services.client_ip import client_ip, client_key
from haulcast.services.ratelimit import BucketStatus, rate_limit_service, rule_for

GetResponse = Callable[[HttpRequest], HttpResponse]


def _policy_header(statuses: Sequence[BucketStatus]) -> str:
    """Format ``RateLimit-Policy``: quota ``q`` per window ``w`` seconds, per bucket."""
    return ", ".join(
        f'"{status.policy.name}";q={status.policy.limit};w={status.policy.window_s}'
        for status in statuses
    )


def _limit_header(statuses: Sequence[BucketStatus]) -> str:
    """Format ``RateLimit``: remaining quota ``r`` and seconds until the bucket is full ``t``."""
    return ", ".join(
        f'"{status.policy.name}";r={status.remaining};t={math.ceil(status.reset_after_s)}'
        for status in statuses
    )


class RateLimitMiddleware:
    """Apply the per-endpoint rate limits to every request."""

    def __init__(self, get_response: GetResponse) -> None:
        """Wrap the next layer of the middleware chain."""
        self._get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        """Take a token for this client, then serve the request or answer 429."""
        rule = rule_for(request.method or "GET", request.path)
        key = client_key(client_ip(request), settings.HAULCAST_RATE_LIMIT_SALT)
        decision = rate_limit_service().take(key, rule)
        if decision.allowed:
            response = self._get_response(request)
            statuses: Sequence[BucketStatus] = decision.statuses
        else:
            response = render_problem(
                ProblemError(
                    "rate_limited",
                    detail="Too many requests; slow down and retry after the indicated delay.",
                    retry_after_s=decision.retry_after_s,
                )
            )
            statuses = decision.statuses[-1:]
        response["RateLimit-Policy"] = _policy_header(statuses)
        response["RateLimit"] = _limit_header(statuses)
        return response
