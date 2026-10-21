# API problems

Every error of the API is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document,
served as `application/problem+json` with `Cache-Control: no-store` (the OpenAPI document declares
exactly that media type for every error status). A problem looks like this:

```json
{
  "type": "https://github.com/ar27111994/weather-aware-truck-routing/blob/main/docs/api/problems.md#validation",
  "title": "Invalid request",
  "status": 422,
  "detail": "body.departure_time: must be an RFC 3339 date-time string",
  "code": "validation_error",
  "errors": [{ "loc": ["body", "departure_time"], "msg": "...", "type": "..." }],
  "request_id": "8d9f2c1e-..."
}
```

- `type` is the link to the entry below; its fragment is the entry's anchor.
- `code` is the stable machine-readable name. Branch on `code`, never on `title` or `detail`; both
  are for people and may be reworded. The codes are the members of the `ProblemCode` enum, which
  the OpenAPI document publishes as the enum of `ProblemSchema.code`.
- `errors` is present for validation problems only (at most 20 entries, each with the location of
  the field, a message and a kind). Input values are never echoed.
- `request_id` is the `X-Request-ID` of the response: quote it when you report a problem.
- A response never contains a stack trace, an upstream's raw error text or a secret.

`Retry-After` (seconds) accompanies a 429 and, when the upstream said how long, a 503. `Allow` accompanies
a 405 and `WWW-Authenticate: Bearer` a 401.

## 400 Bad Request

<a id="bad-request"></a>

### `bad_request`

The request is malformed in a way no more specific code names: a `Host` header this deployment does
not serve, or input the framework refuses as suspicious. Fix the request.

<a id="malformed-json"></a>

### `malformed_json`

The body of a `POST` is not valid JSON (or is nested deeper than a parser accepts). Send a JSON
document.

<a id="invalid-content-type"></a>

### `invalid_content_type`

A `POST` must declare `Content-Type: application/json`. The check comes after the size and origin
checks and before anything is read.

## 401 Unauthorized

<a id="unauthorized"></a>

### `unauthorized`

The internal maintenance endpoint was called without the right bearer secret. The response carries
`WWW-Authenticate: Bearer` and no detail. Only the scheduled job and the operator call this endpoint.

## 403 Forbidden

<a id="forbidden"></a>

### `forbidden`

The server understood the request and refuses it.

<a id="origin-not-allowed"></a>

### `origin_not_allowed`

A `POST` came from a web origin that is neither this deployment nor an explicitly allowed one. The
API answers cross-origin reads only for `GET /api/v1/rules` and `GET /api/v1/openapi.json`.

## 404 Not Found

<a id="not-found"></a>

### `not_found`

There is nothing at this URL. The maintenance endpoint answers it too when it is not configured.

<a id="plan-not-found"></a>

### `plan_not_found`

No plan has this id, the id is malformed, or the plan expired (plans live 7 days). Create a new plan.

## 405 Method Not Allowed

<a id="method-not-allowed"></a>

### `method_not_allowed`

The URL exists but not for this method. The `Allow` header lists the methods it accepts.

## 413 Content Too Large

<a id="payload-too-large"></a>

### `payload_too_large`

The request body is larger than 16 KiB. No endpoint needs more; the body is refused before it is read.

## 422 Unprocessable Content

<a id="validation"></a>

### `validation_error`

A field is missing or outside its range, or `q` of the geocoder is not 2 to 120 characters long once
normalised. `errors` names every offending field (at most 20) and `detail` summarises the first.
Ranges and the allowed values are in the OpenAPI document.

<a id="no-route-found"></a>

### `no_route_found`

No routing provider found a drivable route between the two places. Choose places a road connects.

<a id="same-origin-destination"></a>

### `same_origin_destination`

Origin and destination are less than 1 mile apart.

<a id="route-too-long"></a>

### `route_too_long`

A route is longer than 3,000 miles, the longest this service plans.

<a id="too-many-checkpoints"></a>

### `too_many_checkpoints`

At the chosen interval the trip needs more than 250 distinct forecast locations (points of a 0.1
degree lattice). `detail` names the smallest larger interval that fits, or says that none does.

<a id="departure-out-of-range"></a>

### `departure_out_of_range`

`departure_time` is earlier than 15 minutes ago or later than 120 hours from now. The window is
checked on the time as sent, before it is rounded down to the minute.

## 429 Too Many Requests

<a id="rate-limited"></a>

### `rate_limited`

The client used its allowance for this kind of request. `Retry-After` says when to come back;
`RateLimit-Policy` and `RateLimit` describe the buckets (IETF draft). The limits are per client
address, are listed in [BACKEND.md](../BACKEND.md#rate-limits) and are never stored against a raw address.

## 5xx Server errors

<a id="internal-error"></a>

### `internal_error`

500. Something unexpected failed. Nothing about it is revealed; quote the `request_id`.

<a id="bad-gateway"></a>

### `bad_gateway`

502. An upstream answered with something this service cannot use. Retrying later may help.

<a id="service-unavailable"></a>

### `service_unavailable`

503. The service cannot answer right now: a plan took too long to compute, or an identical plan is
still being computed. Retry after the `Retry-After` delay.

<a id="routing-unavailable"></a>

### `routing_unavailable`

503. No routing provider could serve the trip. Retry later.

<a id="weather-unavailable"></a>

### `weather_unavailable`

503. The forecast provider could not be asked or did not answer. Retry later, or plan with one of
the simulated scenarios, which need no forecast.

<a id="weather-capacity-exhausted"></a>

### `weather_capacity_exhausted`

503. The forecast allowance this service shares with all its users is used up for now (the
upstream's free tier is metered per location). `Retry-After` says when it may be available again;
plans that use a simulated scenario do not draw on it.

<a id="geocoding-unavailable"></a>

### `geocoding_unavailable`

503. Neither place search provider answered. Retry later or enter coordinates another way.

<a id="database-unavailable"></a>

### `database_unavailable`

503. The database could not be reached. Retry later.
