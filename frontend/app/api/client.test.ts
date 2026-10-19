// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { PlanRequest } from "./contract";
import { ApiError, CLIENT_ERROR_CODES } from "./errors";
import { createApiClient, type ApiClientOptions, type ResponseInfo } from "./client";
import { minimalHeatmap, minimalPlan, minimalRules } from "./mocks/minimal";

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

const NOW = Date.parse("2026-10-20T14:00:00Z");

function json(
  body: unknown,
  init: { readonly status?: number; readonly headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function problem(
  status: number,
  code: string,
  headers: Record<string, string> = {},
  extra: object = {},
): Response {
  return new Response(JSON.stringify({ title: `Problem ${code}`, status, code, ...extra }), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}

/** A client wired to a fetch stub with deterministic jitter and an instant, recorded sleep. */
function harness(
  responses: (Response | Error)[],
  options: Partial<ApiClientOptions> = {},
): { client: ReturnType<typeof createApiClient>; fetchStub: FetchStub; sleeps: number[] } {
  const fetchStub: FetchStub = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetchStub.mockRejectedValueOnce(response);
    else fetchStub.mockResolvedValueOnce(response);
  }
  const sleeps: number[] = [];
  const client = createApiClient({
    fetch: fetchStub,
    random: () => 0.5,
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { client, fetchStub, sleeps };
}

function lastCall(fetchStub: FetchStub): { url: string; init: RequestInit } {
  const call = fetchStub.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const [input, init] = call;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return { url, init: init ?? {} };
}

const request: PlanRequest = {
  origin: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" },
  destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
  departure_time: "2026-10-20T14:00:00Z",
  load_weight_lb: 38000,
  sampling_interval_mi: 25,
  scenario: null,
};

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("successful requests", () => {
  it("GETs the geocode endpoint with an encoded query and an Accept header", async () => {
    const { client, fetchStub } = harness([json({ query: "são paulo", results: [] })]);

    const result = await client.geocode("são paulo", { limit: 3 });

    expect(result).toEqual({ query: "são paulo", results: [] });
    const { url, init } = lastCall(fetchStub);
    expect(url).toBe("/api/v1/geocode?q=s%C3%A3o+paulo&limit=3");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(init.body).toBeUndefined();
  });

  it("omits the limit parameter when none is given", async () => {
    const { client, fetchStub } = harness([json({ query: "denver", results: [] })]);
    await client.geocode("denver");
    expect(lastCall(fetchStub).url).toBe("/api/v1/geocode?q=denver");
  });

  it("POSTs a plan as JSON and returns the validated plan", async () => {
    const plan = minimalPlan();
    const { client, fetchStub } = harness([json(plan, { status: 201 })]);

    const result = await client.createPlan(request);

    expect(result.plan_id).toBe(plan.plan_id);
    const { url, init } = lastCall(fetchStub);
    expect(url).toBe("/api/v1/plans");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual(request);
  });

  it("accepts the 200 an idempotent replay returns", async () => {
    const plan = minimalPlan();
    const { client } = harness([json(plan, { status: 200 })]);
    expect((await client.createPlan(request)).plan_id).toBe(plan.plan_id);
  });

  it("GETs a plan, its heatmap, the rules and the scenarios from the contract paths", async () => {
    const plan = minimalPlan();
    const heatmap = minimalHeatmap();
    const { client, fetchStub } = harness([
      json(plan),
      json(heatmap),
      json(minimalRules()),
      json([{ id: "calm", name: "Calm", description: "d" }]),
    ]);

    await client.getPlan(plan.plan_id);
    expect(lastCall(fetchStub).url).toBe(`/api/v1/plans/${plan.plan_id}`);
    await client.getHeatmap(plan.plan_id);
    expect(lastCall(fetchStub).url).toBe(`/api/v1/plans/${plan.plan_id}/heatmap`);
    await client.getRules();
    expect(lastCall(fetchStub).url).toBe("/api/v1/rules");
    expect(await client.getScenarios()).toEqual([{ id: "calm", name: "Calm", description: "d" }]);
    expect(lastCall(fetchStub).url).toBe("/api/v1/scenarios");
  });

  it("honours a custom base URL, trailing slashes included", async () => {
    const { client, fetchStub } = harness([json([])], { baseUrl: "http://localhost:8000/api/v1/" });
    await client.getScenarios();
    expect(lastCall(fetchStub).url).toBe("http://localhost:8000/api/v1/scenarios");
  });

  it("reports every response to onResponse, with the X-Request-ID read back", async () => {
    const seen: ResponseInfo[] = [];
    const { client } = harness([json([], { headers: { "X-Request-ID": "req-abcdef12" } })], {
      onResponse: (info) => seen.push(info),
    });

    await client.getScenarios();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: "/scenarios",
      status: 200,
      requestId: "req-abcdef12",
      attempt: 1,
    });
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a null request id when the header is absent", async () => {
    const seen: ResponseInfo[] = [];
    const { client } = harness([json([])], { onResponse: (info) => seen.push(info) });
    await client.getScenarios();
    expect(seen[0]?.requestId).toBeNull();
  });
});

describe("problem+json errors", () => {
  it("maps a 422 problem into a typed ApiError with its field errors", async () => {
    const body = {
      detail: "departure_time must be within the next 120 hours",
      errors: [{ loc: ["body", "departure_time"], msg: "too far", type: "value_error" }],
      request_id: "body-request-id",
    };
    const { client, fetchStub } = harness([problem(422, "departure_out_of_range", {}, body)]);

    const error = await failure(client.createPlan(request));

    expect(error).toMatchObject({
      status: 422,
      code: "departure_out_of_range",
      title: "Problem departure_out_of_range",
      detail: body.detail,
      errors: body.errors,
      requestId: "body-request-id",
      retryAfterS: null,
      retryable: false,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("prefers the X-Request-ID header over the body's request_id", async () => {
    const { client } = harness([
      problem(
        404,
        "plan_not_found",
        { "X-Request-ID": "header-req-id" },
        { request_id: "body-req-id" },
      ),
    ]);
    const error = await failure(client.getPlan("pln_01JABCDEFGHJKMNPQRSTVWXYZ0"));
    expect(error.requestId).toBe("header-req-id");
    expect(error.status).toBe(404);
  });

  it("reads Retry-After seconds from a 429", async () => {
    const { client } = harness([problem(429, "rate_limited", { "Retry-After": "12" })]);
    const error = await failure(client.createPlan(request));
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterS: 12,
      retryable: true,
    });
  });

  it("reads a Retry-After HTTP date relative to the injected clock", async () => {
    const { client } = harness([
      problem(503, "weather_capacity_exhausted", {
        "Retry-After": "Tue, 20 Oct 2026 14:01:00 GMT",
      }),
    ]);
    const error = await failure(client.createPlan(request));
    expect(error.retryAfterS).toBe(60);
  });

  it("maps a 502 routing_unavailable problem", async () => {
    const { client } = harness([problem(502, "routing_unavailable")]);
    const error = await failure(client.createPlan(request));
    expect(error).toMatchObject({ status: 502, code: "routing_unavailable", retryable: true });
  });

  it("falls back to a generic error for a non-JSON error body (e.g. a CDN HTML page)", async () => {
    const html = new Response("<html>Bad gateway</html>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/html" },
    });
    const { client } = harness([html]);
    const error = await failure(client.createPlan(request));
    expect(error).toMatchObject({
      status: 502,
      code: "http_502",
      title: "Bad Gateway",
      detail: null,
      errors: [],
    });
  });

  it("falls back when the error body is JSON but not a problem document", async () => {
    const { client } = harness([json({ message: "nope" }, { status: 500 })]);
    const error = await failure(client.createPlan(request));
    expect(error).toMatchObject({ status: 500, code: "http_500" });
  });

  it("uses a default title when the status text is empty", async () => {
    const { client } = harness([new Response("", { status: 418 })]);
    const error = await failure(client.getScenarios());
    expect(error).toMatchObject({ status: 418, code: "http_418", title: "Request failed" });
  });
});

describe("response validation", () => {
  it("turns invalid JSON on a 2xx into invalid_response, never a crash", async () => {
    const broken = new Response("{not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const { client } = harness([broken]);
    const error = await failure(client.getScenarios());
    expect(error).toMatchObject({
      status: 200,
      code: CLIENT_ERROR_CODES.invalidResponse,
      retryable: false,
    });
    expect(error.detail).toBe("The response body is not valid JSON");
  });

  it("turns a wrong-shaped payload into invalid_response and lists where it is wrong", async () => {
    const plan = minimalPlan();
    const wrong = { ...plan, routes: "nope" };
    const { client } = harness([json(wrong, { status: 201 })]);

    const error = await failure(client.createPlan(request));

    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
    expect(error.status).toBe(201);
    expect(error.errors.some((issue) => issue.loc.join(".") === "routes")).toBe(true);
    expect(error.detail).toContain("routes");
  });

  it("describes a root-level mismatch without a path", async () => {
    const { client } = harness([json({ not: "an array" })]);
    const error = await failure(client.getScenarios());
    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
    expect(error.detail).toBe(
      "The response does not match the API contract: (root): Invalid input: expected array, received object",
    );
  });

  it("caps the reported field errors so a badly broken payload stays small", async () => {
    const wrong = Array.from({ length: 50 }, () => ({ id: 1 }));
    const { client } = harness([json(wrong)]);
    const error = await failure(client.getScenarios());
    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
    expect(error.errors.length).toBeGreaterThan(0);
    expect(error.errors).toHaveLength(20);
  });

  it("rejects a plan that breaks a structural invariant", async () => {
    const plan = minimalPlan();
    const first = plan.routes[0];
    if (!first) throw new Error("fixture has no routes");
    const broken = {
      ...plan,
      routes: [{ ...first, cumulative_mi: first.cumulative_mi.slice(1) }, ...plan.routes.slice(1)],
    };
    const { client } = harness([json(broken, { status: 201 })]);
    const error = await failure(client.createPlan(request));
    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
  });
});

describe("network failures, aborts and timeouts", () => {
  it("maps a rejected fetch to network_error and keeps the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const { client } = harness([cause], { retry: { maxRetries: 0 } });
    const error = await failure(client.getScenarios());
    expect(error).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.network, retryable: true });
    expect(error.cause).toBe(cause);
  });

  it("maps a caller abort to aborted, without retrying", async () => {
    const controller = new AbortController();
    const fetchStub = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = createApiClient({ fetch: fetchStub });

    const pending = failure(client.getScenarios({ signal: controller.signal }));
    controller.abort();
    const error = await pending;

    expect(error).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.aborted, retryable: false });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("treats an already-aborted signal as aborted before sending anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, fetchStub } = harness([json([])]);
    const error = await failure(client.getScenarios({ signal: controller.signal }));
    expect(error.code).toBe(CLIENT_ERROR_CODES.aborted);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("maps an expired per-request timeout to timeout", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        }),
    );
    const client = createApiClient({ fetch: fetchStub, retry: { maxRetries: 0 } });

    const error = await failure(client.getScenarios({ timeoutMs: 15 }));

    expect(error).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.timeout, retryable: true });
  });

  it("applies the client-level timeout when the call sets none", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        }),
    );
    const client = createApiClient({ fetch: fetchStub, timeoutMs: 15, retry: { maxRetries: 0 } });
    const error = await failure(client.getScenarios());
    expect(error.code).toBe(CLIENT_ERROR_CODES.timeout);
  });

  it("covers the body read with the timeout as well", async () => {
    // The response headers arrive, but the body never completes; like a real fetch, the stream
    // errors once the request signal aborts.
    const fetchStub = vi.fn<typeof fetch>((_url, init) => {
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("timed out", "TimeoutError"));
          });
        },
      });
      return Promise.resolve(new Response(stalledBody, { status: 200 }));
    });
    const client = createApiClient({ fetch: fetchStub, retry: { maxRetries: 0 } });
    const error = await failure(client.getScenarios({ timeoutMs: 30 }));
    expect(error.code).toBe(CLIENT_ERROR_CODES.timeout);
  });
});

describe("retry policy", () => {
  it("retries an idempotent GET after a 503 with full-jitter backoff", async () => {
    const { client, fetchStub, sleeps } = harness([problem(503, "weather_unavailable"), json([])]);
    await client.getScenarios();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    // random() = 0.5 and base 300 ms -> 0.5 * 300 * 2^0
    expect(sleeps).toEqual([150]);
  });

  it("doubles the backoff ceiling on each further attempt and caps it", async () => {
    const { client, sleeps } = harness(
      [problem(503, "x"), problem(503, "x"), problem(503, "x"), json([])],
      { retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1500 } },
    );
    await client.getScenarios();
    expect(sleeps).toEqual([500, 750, 750]);
  });

  it("never waits less than the server's Retry-After", async () => {
    const { client, sleeps } = harness([problem(503, "x", { "Retry-After": "2" }), json([])]);
    await client.getScenarios();
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry when Retry-After exceeds the cap and surfaces the delay instead", async () => {
    const { client, fetchStub } = harness([problem(429, "rate_limited", { "Retry-After": "60" })]);
    const error = await failure(client.getScenarios());
    expect(error).toMatchObject({ status: 429, retryAfterS: 60 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { client, fetchStub, sleeps } = harness([
      problem(502, "a"),
      problem(502, "b"),
      problem(502, "c"),
    ]);
    const error = await failure(client.getScenarios());
    expect(error.code).toBe("c");
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it("retries a network failure and a timeout, then succeeds", async () => {
    const { client, fetchStub } = harness([new TypeError("offline"), json([])]);
    await client.getScenarios();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST, whatever the failure", async () => {
    const cases: (Response | Error)[][] = [
      [problem(503, "x")],
      [new TypeError("offline")],
      [problem(429, "rate_limited")],
    ];
    for (const responses of cases) {
      const { client, fetchStub, sleeps } = harness(responses);
      await failure(client.createPlan(request));
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("never retries client errors", async () => {
    for (const status of [400, 404, 413, 422]) {
      const { client, fetchStub } = harness([problem(status, "nope")]);
      await failure(client.getScenarios());
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries an invalid response", async () => {
    const { client, fetchStub } = harness([json({ not: "an array" })]);
    await failure(client.getScenarios());
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("stops retrying the moment the caller aborts during the backoff", async () => {
    const controller = new AbortController();
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(problem(503, "x"));
    const client = createApiClient({
      fetch: fetchStub,
      random: () => 0.5,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    const error = await failure(client.getScenarios({ signal: controller.signal }));

    expect(error.code).toBe(CLIENT_ERROR_CODES.aborted);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reports each attempt to onResponse with its attempt number", async () => {
    const seen: ResponseInfo[] = [];
    const { client } = harness([problem(503, "x"), json([])], {
      onResponse: (info) => seen.push(info),
    });
    await client.getScenarios();
    expect(seen.map((info) => [info.status, info.attempt])).toEqual([
      [503, 1],
      [200, 2],
    ]);
  });
});

describe("defaults", () => {
  it("uses the global fetch, a real timer-based sleep and the system clock when none are injected", async () => {
    const original = globalThis.fetch;
    const stub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(503, "x"))
      .mockResolvedValueOnce(json([]));
    globalThis.fetch = stub;
    try {
      const client = createApiClient({ retry: { baseDelayMs: 1, maxDelayMs: 2 } });
      expect(await client.getScenarios()).toEqual([]);
      expect(stub).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("wakes a default sleep early when the caller aborts", async () => {
    const controller = new AbortController();
    const stub = vi.fn<typeof fetch>().mockResolvedValue(problem(503, "x", { "Retry-After": "5" }));
    const client = createApiClient({ fetch: stub, retry: { maxRetryAfterMs: 10_000 } });

    const pending = failure(client.getScenarios({ signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 20);

    const error = await pending;
    expect(error.code).toBe(CLIENT_ERROR_CODES.aborted);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
