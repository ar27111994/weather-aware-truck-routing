// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PlanRequest } from "../contract";

vi.mock("./plan-builder", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-builder")>();
  return {
    ...original,
    buildPlan: () => {
      throw new Error("builder exploded");
    },
  };
});

const { createMockApi, createMockServer } = await import("./handlers");
const { GEOCODE_CATALOG } = await import("./trips");

const server = createMockServer(createMockApi());
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterAll(() => {
  server.close();
});

describe("an unexpected failure inside the mock backend", () => {
  it("becomes a 500 problem instead of an unhandled exception", async () => {
    const entry = GEOCODE_CATALOG[0];
    if (!entry) throw new Error("empty catalog");
    const place = { lat: entry.lat, lon: entry.lon, label: entry.label };
    const body: PlanRequest = {
      origin: place,
      destination: { ...place, lat: place.lat + 1 },
      departure_time: "2026-10-20T14:00:00Z",
      load_weight_lb: 0,
      sampling_interval_mi: 25,
      scenario: null,
    };

    const response = await fetch("http://api.test/api/v1/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal_error", status: 500 });
  });
});
