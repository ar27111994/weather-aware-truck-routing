# Frontend API layer

Everything the UI needs to talk to `/api/v1`: typed and validated responses, one error type, a
fetch client, TanStack Query hooks, and a deterministic mock backend built from real routes.
The contract is `.planning/API-CONTRACT.md`; the schemas follow it field for field, with the few
interpretations listed under "Where the contract is silent" below.

| Where                    | What                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `contract.ts`            | Zod schemas and inferred types for every response (`Plan`, `Heatmap`, …)               |
| `zod.ts`                 | The one runtime entry to Zod, `jitless` so it never compiles code (strict CSP)         |
| `errors.ts`              | `ApiError`, `isApiError`, `isAbortedError`, `CLIENT_ERROR_CODES`                       |
| `client.ts`              | `createApiClient()`: timeout, abort, GET-only retry, `X-Request-ID`                    |
| `signals.ts`             | `linkSignals()`: `AbortSignal.any`, with a fallback for browsers that lack it          |
| `queries.ts`             | Hooks, `queryKeys`, `CACHE_POLICY`, `createQueryClient()`                              |
| `mocks/`                 | MSW handlers, `buildPlan`/`buildHeatmap`, error fixtures (`node.ts`: Node-only server) |
| `../lib/`                | `format.ts` (display), `risk.ts` (rules from the JSON), `geo.ts` (paths)               |
| `../state/trip-store.ts` | Shared map ↔ results state (selected route, hover, slider frame, …)                    |

`contract.ts` is a hand-written mirror. The integration card replaces it with OpenAPI-generated
types; names match the contract so the swap is mechanical.

## Use it

```tsx
const queryClient = createQueryClient(); // no query retries (the client makes 3 tries per GET), no focus refetch

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
- The trip store (`../state/trip-store.ts`) is safe to read in the prerendered routes: on the
  server and while the client hydrates the prerendered HTML its hooks return the store's initial
  state, then follow updates.
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

A caller's `signal` and the per-attempt timeout are linked with `AbortSignal.any` where the browser
has it (Chrome 116, Firefox 124, Safari 17.4) and with listeners elsewhere (`signals.ts`).

The client raises four codes itself: `network_error`, `timeout`, `aborted`, `invalid_response`.
Only idempotent GETs are retried (two retries, full jitter, never sooner than `Retry-After`);
`POST /plans` is never retried.

## Retries and request counts

A failing GET is **three requests**, by decision (Q6, R4F): the first attempt and the client's two
retries (`DEFAULT_RETRY_POLICY`). `createQueryClient()` adds none (`retry: false`), so a failing
`useHeatmap` is 3 requests and not 3 × 3. Without a `Retry-After` the waits are random: up to 300 ms
before the first retry and up to 600 ms before the second (150 ms and 300 ms at the middle of the
range), so the error shows less than 0.9 s later than a single attempt would. A `Retry-After` raises
each wait to at least that many seconds, and above 10 s the client does not retry at all.

We kept it, for these reasons:

- **A heatmap is read once per plan.** Its query key is the plan id and the result stays fresh for
  five minutes (`CACHE_POLICY`); the slider only picks one of the 49 frames already loaded. A
  failure costs three requests once, not three per slider step.
- **The cost is bounded.** The server allows 30 `GET /heatmap` a minute per client
  (`backend/src/haulcast/services/ratelimit.py`), so a failing heatmap uses 3 of them. A 503 that
  asks for more than 10 s (`weather_capacity_exhausted` carries `Retry-After`) is one request: the
  UI shows the wait instead of the client hammering a server that said it is out of capacity.
- **A retry never outlives its caller.** The caller's `signal` ends the wait (unmount, a new plan)
  and no further request is sent.
- **One endpoint cannot have its own policy today.** `RequestOptions` has no `retry`; the policy is
  set per client (`ApiClientOptions.retry`). A new per-call option for one caller, with no failure
  on record that it would prevent, is more surface than this question is worth.

A timeout is a failure the client retries too (`retryable`), so the worst case for a heatmap that
never answers is three attempts of `DEFAULT_TIMEOUTS_MS.getHeatmap` (30 s) plus the two waits. No
test pins that figure; if it is ever too long, lower that timeout rather than the count.

`heatmap-retry.test.ts` pins the rest through MSW with the default policy: three GETs, 150 ms and
300 ms apart; one GET for a long `Retry-After`; none after an abort; and three GETs through
`useHeatmap` with the real `createQueryClient()`. A change of `maxRetries`, of the delays, of the
`Retry-After` cap or of the query layer's `retry: false` fails it. To change the decision, change
the test, this section and the `createQueryClient()` comment together.

## Mock backend (tests and development)

Import `createMockServer` from `mocks/node` (Node only). The `mocks` barrel is browser-safe: it
never loads `msw/node`, so a browser dev-mock bootstrap (not written yet) can import it, and
`browser-barrel.test.ts` enforces that at load time (keep `msw/node` out of every other module too,
even behind a lazy `import()`).

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

In Vitest, call `startMockApi()` from `test/api.tsx` instead: it does the lifecycle above and returns
the server, the mock backend and a client. Every request that a test sends to the mock server goes
through `closeConnections` (`test/close-connections.ts`), which adds `Connection: close`: take
`client` from `startMockApi()`, or pass `fetch: closeConnections` to a client of your own. That is a
workaround for [mswjs/interceptors#862](https://github.com/mswjs/interceptors/issues/862) (open on
msw 3.0.3): MSW can let a request on a reused socket go to the real network while its handler holds
it, and the test then fails at random. A test fails, naming the issue, when a request reaches the
mock server without the header. Remove the workaround when a release of msw or `@mswjs/interceptors`
closes the issue.

`errorFixtures`: `validation422`, `rateLimited429`, `routingUnavailable502`, `networkFailure`,
`malformedJson`. Each defaults to `POST /plans`; pass `{ method: "get", path: "/geocode" }` to
target another endpoint.

Plans come from three recorded trips, using REAL Valhalla geometries (three routes each):
**Salt Lake City → Denver**, **Chicago → Denver**, **Newark → Jersey City** (endpoints within
30 mi). Any other pair is a 422 `no_route_found`. Pick a scenario with the request's `scenario`:

| `scenario`          | What it shows                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `calm`              | Every checkpoint Low                                                                            |
| `mixed`             | Rain, wind and snow patches on different routes; nothing worse than High                        |
| `severe-on-fastest` | The fastest route crosses Severe miles; a slower one is recommended (every trip, every spacing) |
| `no-safe-route`     | Every route crosses No Travel; `recommendation.status = "no_safe_route"`                        |
| `partial-unknown`   | Missing values: some checkpoints Unknown, some `incomplete`                                     |
| `null`              | Behaves like `mixed` but is labelled as the real forecast                                       |

The heatmap's cells are at least 0.2 degrees wide, so a storm smaller than that, like the
one-mile `severe-on-fastest` squall on Newark → Jersey City, shows in the plan's checkpoints but not
on the heatmap.

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
- Heatmap `grid.lat0` / `grid.lon0` are the **south-west corner** of the grid, not the centre of
  cell 0. Row 0 is the southern row and rows grow northward; `cells[i]` is `row * cols + col`.
  Cell `(row, col)` spans `lat0 + row * dlat` to `lat0 + (row + 1) * dlat` (longitude alike), and
  its forecast is sampled at the cell centre, `lat0 + (row + 0.5) * dlat`,
  `lon0 + (col + 0.5) * dlon`. The contract's example gives `lat0`, `lon0`, `dlat`, `dlon`, `rows`
  and `cols` without saying whether `lat0` / `lon0` is a corner or a centre, or which way rows run,
  so this is a guess. The mock builds its grid this way (`buildHeatmap` in `mocks/plan-builder.ts`,
  pinned by a test). If the backend anchors it differently, the field is drawn up to half a cell
  (0.25 degrees, about 17 mi) away from where it was sampled and nothing flags it: the map card
  and the backend must agree before integration, then `buildHeatmap` and this note change together.
  A backend that numbers the rows from the north mirrors the whole field instead (by hundreds of
  miles on the long trips), and that is not flagged either.
  Related: the contract aligns the grid to the 0.1 degree weather lattice so its cells reuse the
  checkpoints' cache keys. The mock aligns the corner, so its cell centres are off the lattice for
  0.3 and 0.5 degree steps; a backend that aligns the centres instead returns `lat0` half a cell
  south of a lattice point.

## Regenerating the recorded routes

`mocks/data/trips.json` is generated, not hand-edited. From the repo root, against the T1 research
samples (`.planning/research/samples/`, local only):

```sh
node frontend/scripts/extract-route-fixtures.js <samples-dir> <output.json>
```

The file records the SHA-256 of every source sample, and re-running the script reproduces it
exactly.
