// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, requireClosedConnections } from "../../../test/close-connections";
import { createApiClient } from "../client";
import { isPlanId, type PlanRequest } from "../contract";
import { ApiError } from "../errors";
import { createMockApi, errorFixtures, problemResponse } from "./handlers";
import { createMockServer } from "./node";
import { GEOCODE_CATALOG } from "./trips";

const BASE = "http://api.test/api/v1";
const api = createMockApi();
const server = createMockServer(api);
requireClosedConnections(server);
const client = createApiClient({
  baseUrl: BASE,
  retry: { maxRetries: 0 },
  fetch: closeConnections,
});

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const city = (name: string): PlanRequest["origin"] => {
  const entry = GEOCODE_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(name);
  return { lat: entry.lat, lon: entry.lon, label: entry.label };
};

const request: PlanRequest = {
  origin: city("Salt Lake City"),
  destination: city("Denver"),
  departure_time: "2026-10-20T14:00:00Z",
  load_weight_lb: 38000,
  sampling_interval_mi: 25,
  scenario: "calm",
};

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

function raw(path: string, init?: RequestInit): Promise<Response> {
  return closeConnections(`${BASE}${path}`, init);
}

describe("problemResponse", () => {
  it("builds a problem+json response with optional parts", async () => {
    const bare = problemResponse(404, "plan_not_found", "Plan not found");
    expect(bare.headers.get("Content-Type")).toBe("application/problem+json");
    expect(bare.headers.get("Retry-After")).toBeNull();
    expect(await bare.json()).toMatchObject({
      status: 404,
      code: "plan_not_found",
      request_id: "mock-req-000000",
    });

    const full = problemResponse(429, "rate_limited", "Slow down", {
      detail: "Too fast",
      errors: [{ loc: ["body"], msg: "m", type: "t" }],
      retryAfterS: 7,
      requestId: "req-custom-1",
    });
    expect(full.headers.get("Retry-After")).toBe("7");
    expect(full.headers.get("X-Request-ID")).toBe("req-custom-1");
    expect(await full.json()).toMatchObject({
      detail: "Too fast",
      errors: [{ loc: ["body"], msg: "m", type: "t" }],
    });
  });
});

describe("mock endpoints", () => {
  it("answers both health probes", async () => {
    expect(await (await raw("/health")).json()).toEqual({
      status: "ok",
      version: "0.0.0-mock",
      commit: "mock000",
    });
    expect(await (await raw("/health/ready")).json()).toEqual({ status: "ok" });
  });

  it("searches the catalog with a default and an explicit limit", async () => {
    const found = await client.geocode("den");
    expect(found.query).toBe("den");
    expect(found.results[0]?.name).toBe("Denver");
    expect((await client.geocode("ew", { limit: 1 })).results).toHaveLength(1);
    expect((await client.geocode("ew", { limit: 2 })).results).toHaveLength(2);
    expect((await client.geocode("  DEN ")).query).toBe("den");
  });

  it.each([
    ["", "5"],
    ["d", "5"],
    ["x".repeat(121), "5"],
    ["den", "0"],
    ["den", "9"],
    ["den", "1.5"],
  ])("rejects geocode q=%j limit=%s with a 422 problem", async (q, limit) => {
    const response = await raw(`/geocode?q=${encodeURIComponent(q)}&limit=${limit}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "validation_error",
      errors: [{ loc: ["query", "q"] }],
    });
  });

  it("treats a missing q as too short", async () => {
    expect((await raw("/geocode")).status).toBe(422);
  });

  it("creates a plan (201 + Location), replays an identical request (200) and serves it back", async () => {
    const created = await raw("/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(created.status).toBe(201);
    const plan = (await created.json()) as { plan_id: string };
    expect(isPlanId(plan.plan_id)).toBe(true);
    expect(created.headers.get("Location")).toBe(`/api/v1/plans/${plan.plan_id}`);
    expect(created.headers.get("X-Request-ID")).toMatch(/^mock-req-\d{6}$/);

    const replay = await raw("/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { plan_id: string }).plan_id).toBe(plan.plan_id);

    expect((await client.getPlan(plan.plan_id)).plan_id).toBe(plan.plan_id);
    const heatmap = await client.getHeatmap(plan.plan_id);
    expect(heatmap.plan_id).toBe(plan.plan_id);
    expect(api.heatmaps.has(plan.plan_id)).toBe(true);
    expect(await client.getHeatmap(plan.plan_id)).toEqual(heatmap);
  });

  it("returns a typed plan through the client", async () => {
    const plan = await client.createPlan({ ...request, scenario: "severe-on-fastest" });
    expect(plan.recommendation.route_id).not.toBe("A");
  });

  it("rejects an unknown plan and its heatmap with 404", async () => {
    const unknown = "pln_01JABCDEFGHJKMNPQRSTVWXYZ9";
    expect(await failure(client.getPlan(unknown))).toMatchObject({
      status: 404,
      code: "plan_not_found",
    });
    expect(await failure(client.getHeatmap(unknown))).toMatchObject({
      status: 404,
      code: "plan_not_found",
    });
  });

  it("rejects the wrong content type, malformed JSON and schema violations", async () => {
    const wrongType = await raw("/plans", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(wrongType.status).toBe(400);
    const noType = await raw("/plans", { method: "POST", body: new Blob(["{}"]) });
    expect(noType.status).toBe(400);
    const badJson = await raw("/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(await badJson.json()).toMatchObject({ status: 400, code: "invalid_json" });

    const invalid = {
      ...request,
      sampling_interval_mi: 30,
      origin: { lat: 99, lon: 0, label: "x" },
    };
    const response = await raw("/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { errors: { loc: (string | number)[] }[] };
    expect(problem.errors.every((error) => error.loc[0] === "body")).toBe(true);
    expect(problem.errors.some((error) => error.loc.includes("sampling_interval_mi"))).toBe(true);
  });

  it("maps domain rejections to 422 problems with their own codes", async () => {
    const noRoute = await failure(
      client.createPlan({ ...request, origin: city("Seattle"), destination: city("Phoenix") }),
    );
    expect(noRoute).toMatchObject({ status: 422, code: "no_route_found" });
    const same = await failure(client.createPlan({ ...request, destination: request.origin }));
    expect(same).toMatchObject({ status: 422, code: "same_origin_destination" });
    const unknown = await failure(client.createPlan({ ...request, scenario: "plains-blizzard" }));
    expect(unknown).toMatchObject({ status: 422, code: "unknown_scenario" });
  });

  it("serves the shared rules and the scenario catalog", async () => {
    expect((await client.getRules()).version).toBe("1.0.0");
    expect((await client.getScenarios()).map((scenario) => scenario.id)).toEqual([
      "calm",
      "mixed",
      "severe-on-fastest",
      "no-safe-route",
      "partial-unknown",
    ]);
  });

  it("starts every mock backend with its own empty plan store", () => {
    expect(createMockApi().plans.size).toBe(0);
  });
});

describe("error fixtures", () => {
  it("validation422 carries a field error", async () => {
    server.use(errorFixtures.validation422());
    const error = await failure(client.createPlan(request));
    expect(error).toMatchObject({ status: 422, code: "departure_out_of_range", retryable: false });
    expect(error.errors[0]?.loc).toEqual(["body", "departure_time"]);
  });

  it("rateLimited429 carries Retry-After (default 3 s, or the one given)", async () => {
    server.use(errorFixtures.rateLimited429());
    expect(await failure(client.createPlan(request))).toMatchObject({
      status: 429,
      retryAfterS: 3,
      retryable: true,
    });
    server.use(errorFixtures.rateLimited429({ retryAfterS: 9 }));
    expect(await failure(client.createPlan(request))).toMatchObject({ retryAfterS: 9 });
  });

  it("routingUnavailable502 carries Retry-After", async () => {
    server.use(errorFixtures.routingUnavailable502());
    expect(await failure(client.createPlan(request))).toMatchObject({
      status: 502,
      code: "routing_unavailable",
      retryAfterS: 5,
    });
  });

  it("networkFailure never reaches a server", async () => {
    server.use(errorFixtures.networkFailure());
    expect(await failure(client.createPlan(request))).toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("malformedJson is a 2xx the client refuses", async () => {
    server.use(errorFixtures.malformedJson());
    expect(await failure(client.createPlan(request))).toMatchObject({ code: "invalid_response" });
  });

  it("can target another endpoint and method", async () => {
    server.use(errorFixtures.rateLimited429({ method: "get", path: "/geocode" }));
    expect(await failure(client.geocode("den"))).toMatchObject({ status: 429 });
    server.use(errorFixtures.validation422({ method: "get", path: "/scenarios" }));
    expect(await failure(client.getScenarios())).toMatchObject({ status: 422 });
    server.use(errorFixtures.routingUnavailable502({ method: "get", path: "/rules" }));
    expect(await failure(client.getRules())).toMatchObject({ status: 502 });
    server.use(errorFixtures.networkFailure({ method: "get", path: "/scenarios" }));
    expect(await failure(client.getScenarios())).toMatchObject({ code: "network_error" });
    server.use(errorFixtures.malformedJson({ method: "get", path: "/rules" }));
    expect(await failure(client.getRules())).toMatchObject({ code: "invalid_response" });
  });
});
