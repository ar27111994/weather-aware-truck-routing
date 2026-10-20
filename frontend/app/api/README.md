# Frontend API layer

Everything the UI needs to talk to `/api/v1`: typed and validated responses, one error type, a
fetch client, TanStack Query hooks, and a deterministic mock backend built from real routes.
The contract is `.planning/API-CONTRACT.md`; the schemas follow it field for field, with the few
interpretations listed under "Where the contract is silent" below.

| Where                    | What                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `contract.ts`            | Zod schemas and inferred types for every response (`Plan`, `Heatmap`, …) |
| `errors.ts`              | `ApiError`, `isApiError`, `isAbortedError`, `CLIENT_ERROR_CODES`         |
| `client.ts`              | `createApiClient()`: timeout, abort, GET-only retry, `X-Request-ID`      |
| `queries.ts`             | Hooks, `queryKeys`, `CACHE_POLICY`, `createQueryClient()`                |
| `mocks/`                 | MSW handlers, `buildPlan`/`buildHeatmap`, error fixtures                 |
| `../lib/`                | `format.ts` (display), `risk.ts` (rules from the JSON), `geo.ts` (paths) |
| `../state/trip-store.ts` | Shared map ↔ results state (selected route, hover, slider frame, …)      |

`contract.ts` is a hand-written mirror. The integration card replaces it with OpenAPI-generated
types; names match the contract so the swap is mechanical.

## Use it

```tsx
const queryClient = createQueryClient(); // no query retries (the client retries GETs), no focus refetch

<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
```

`ApiClientProvider` is optional: without it the hooks use a same-origin `/api/v1` client.

```ts
const suggestions = useGeocode(debouncedText); // idle below 2 chars; keeps the previous list
const create = useCreatePlan(); // create.mutate(request); create.cancel()
const plan = usePlan(planId); // share links; idle until the id looks like pln_…
const heatmap = useHeatmap(planId); // 49 frames; large, so structural sharing is off
const rules = useRules(); // the same document as lib/risk's RISK_RULES
const scenarios = useScenarios();
```

- `create.mutate` again while a request is in flight aborts the earlier one; only the latest
  submission drives `status`, `data` and `error`. A created plan is also written to the
  `usePlan(plan.plan_id)` cache. After it succeeds call `tripStore.actions.resetForPlan(plan)`.
- Every response is validated. A body that breaks the contract (bad JSON, misaligned arrays, a
  `coord_end` outside the geometry, two recommended routes, …) rejects with
  `ApiError { code: "invalid_response" }`; the UI never receives a malformed `Plan`.

## Errors

```ts
if (isAbortedError(error)) return; // superseded or cancelled: stay silent
if (isApiError(error)) {
  error.code; // "routing_unavailable", "departure_out_of_range", "http_500", …
  error.status; // HTTP status, 0 when no response arrived
  error.errors; // field errors for a 422: [{ loc: ["body", "departure_time"], msg, type }]
  error.retryable; // network, timeout, 408/429/5xx
  error.retryAfterS; // seconds from Retry-After; above 10 s the client does not wait, the UI should
  error.requestId; // X-Request-ID, for support
}
```

The client raises four codes itself: `network_error`, `timeout`, `aborted`, `invalid_response`.
Only idempotent GETs are retried (two retries, full jitter, never sooner than `Retry-After`);
`POST /plans` is never retried.

## Mock backend (tests and development)

```ts
const server = createMockServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// Node's fetch needs an absolute URL; the handlers match any origin under /api/v1.
const client = createApiClient({ baseUrl: "http://api.test/api/v1" });

server.use(errorFixtures.rateLimited429({ retryAfterS: 3 })); // one endpoint now fails
```

`errorFixtures`: `validation422`, `rateLimited429`, `routingUnavailable502`, `networkFailure`,
`malformedJson`. Each defaults to `POST /plans`; pass `{ method: "get", path: "/geocode" }` to
target another endpoint.

Plans come from three recorded trips, using REAL Valhalla geometries (three routes each):
**Salt Lake City → Denver**, **Chicago → Denver**, **Newark → Jersey City** (endpoints within
30 mi). Any other pair is a 422 `no_route_found`. Pick a scenario with the request's `scenario`:

| `scenario`          | What it shows                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| `calm`              | Every checkpoint Low                                                     |
| `mixed`             | Rain, wind and snow patches on different routes; nothing worse than High |
| `severe-on-fastest` | The fastest route crosses Severe miles, so a slower route is recommended |
| `no-safe-route`     | Every route crosses No Travel; `recommendation.status = "no_safe_route"` |
| `partial-unknown`   | Missing values: some checkpoints Unknown, some `incomplete`              |
| `null`              | Behaves like `mixed` but is labelled as the real forecast                |

Plans and heatmaps are deterministic (same request, same ids and numbers). `POST /plans` answers
201 the first time and 200 with the same `plan_id` for an identical request; `GET /plans/{id}`
only knows plans created through the same `createMockApi()` instance (404 otherwise).

In the browser use `setupWorker(...createMockApi().handlers)` from `msw/browser`; the `msw/vite`
plugin (`msw({ mode: "worker-only" })`) serves the worker script.

## Where the contract is silent

These are interpretations, not facts. The backend and integration cards should confirm them (a
wrong guess shows up as `invalid_response`, never as a crash):

- Heatmap `risk` marks unknown cells `-1` (the contract says so). The other four fields have no
  stated encoding, so they are `number | null` and the mocks use `null`.
- Geocode `region`, `country` and `country_code` are nullable: a state- or country-level hit has no
  region, and one missing field must not reject the whole suggestion list.
- `Σ owned_mi == distance_mi` is **not** enforced by the schema (backend rounding could trip it); the
  fixture tests enforce it. Aligned `cumulative_*` arrays, `coord_start..coord_end` inside the
  geometry, rank order and exactly one recommended route **are** enforced.
- `request.scenario` is optional and nullable.

## Regenerating the recorded routes

`mocks/data/trips.json` is generated, not hand-edited. From the repo root, against the T1 research
samples (`.planning/research/samples/`, local only):

```sh
node frontend/scripts/extract-route-fixtures.js <samples-dir> <output.json>
```

The file records the SHA-256 of every source sample, and re-running the script reproduces it
exactly.
