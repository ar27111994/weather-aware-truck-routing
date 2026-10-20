import { describe, expect, it } from "vitest";

import riskRulesJson from "../../../shared/risk-rules.json";
import {
  HEATMAP_FIELDS,
  HEATMAP_FRAME_COUNT,
  RISK_LEVELS,
  SAMPLING_INTERVALS_MI,
  geocodeResponseSchema,
  heatmapSchema,
  isPlanId,
  nullableRiskLevelSchema,
  planRequestSchema,
  planSchema,
  problemSchema,
  riskLevelSchema,
  riskRulesSchema,
  scenariosResponseSchema,
} from "./contract";
import {
  MINIMAL_PLAN_ID,
  MINIMAL_T0,
  rawCheckpoint,
  rawHeatmap,
  rawPlan,
  rawRoute,
} from "./mocks/minimal";

interface Parseable {
  safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
}

/** Parses `value` and returns the messages of the issues it produced (empty when valid). */
function issuesOf(schema: Parseable, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);
}

/** A plan holding only route B (rank 1), whose fields can be overridden. */
function planWithOnlyRoute(overrides: Record<string, unknown>): Record<string, unknown> {
  return rawPlan({
    routes: [rawRoute("B", 1, overrides)],
    recommendation: { route_id: "B", status: "ok", decided_by: "tie", rationale: [], warnings: [] },
  });
}

describe("risk levels", () => {
  it("accepts exactly the five contract levels, in ascending severity", () => {
    expect(RISK_LEVELS).toEqual(["low", "moderate", "high", "severe", "no_travel"]);
    for (const level of RISK_LEVELS) {
      expect(riskLevelSchema.parse(level)).toBe(level);
    }
    expect(riskLevelSchema.safeParse("unknown").success).toBe(false);
    expect(riskLevelSchema.safeParse(null).success).toBe(false);
  });

  it("treats null as the separate unknown state", () => {
    expect(nullableRiskLevelSchema.parse(null)).toBeNull();
    expect(nullableRiskLevelSchema.parse("severe")).toBe("severe");
  });
});

describe("isPlanId", () => {
  it("accepts pln_ plus a 26-character Crockford ULID", () => {
    expect(isPlanId(MINIMAL_PLAN_ID)).toBe(true);
  });

  it.each([
    ["wrong prefix", "plan_01JABCDEFGHJKMNPQRSTVWXYZ0"],
    ["too short", "pln_01JABCDEFGHJKMNPQRSTVWXYZ"],
    ["too long", "pln_01JABCDEFGHJKMNPQRSTVWXYZ00"],
    ["lowercase", "pln_01jabcdefghjkmnpqrstvwxyz0"],
    ["excluded letter I", "pln_01IABCDEFGHJKMNPQRSTVWXYZ0"],
    ["excluded letter U", "pln_01UABCDEFGHJKMNPQRSTVWXYZ0"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(isPlanId(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}]])("rejects the non-string %j", (value) => {
    expect(isPlanId(value)).toBe(false);
  });
});

describe("geocodeResponseSchema", () => {
  const example = {
    query: "denver",
    results: [
      {
        id: "osm:R1411339",
        label: "Denver, Colorado, United States",
        name: "Denver",
        region: "Colorado",
        country: "United States",
        country_code: "US",
        kind: "city",
        lat: 39.7392,
        lon: -104.9903,
      },
    ],
  };

  it("parses the contract example", () => {
    expect(geocodeResponseSchema.parse(example)).toEqual(example);
  });

  it("accepts null region/country/country_code (providers omit them for state-level hits)", () => {
    const sparse = {
      query: "texas",
      results: [{ ...example.results[0], region: null, country: null, country_code: null }],
    };
    expect(geocodeResponseSchema.safeParse(sparse).success).toBe(true);
  });

  it("rejects out-of-range coordinates", () => {
    const bad = { ...example, results: [{ ...example.results[0], lat: 91 }] };
    expect(geocodeResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe("planRequestSchema", () => {
  const example = rawPlan()["request"] as Record<string, unknown>;

  it("parses the contract example and treats scenario as optional", () => {
    expect(planRequestSchema.safeParse(example).success).toBe(true);
    const withoutScenario = Object.fromEntries(
      Object.entries(example).filter(([key]) => key !== "scenario"),
    );
    expect(planRequestSchema.safeParse(withoutScenario).success).toBe(true);
    expect(planRequestSchema.safeParse({ ...example, scenario: "plains-blizzard" }).success).toBe(
      true,
    );
  });

  it.each([
    ["an interval outside {10, 25, 50}", { sampling_interval_mi: 30 }],
    ["a departure time without the Z suffix", { departure_time: "2026-10-20T14:00:00+05:00" }],
    ["a fractional load", { load_weight_lb: 38000.5 }],
    ["a negative load", { load_weight_lb: -1 }],
    ["an empty label", { origin: { lat: 1, lon: 1, label: "" } }],
    ["a label over 200 characters", { origin: { lat: 1, lon: 1, label: "x".repeat(201) } }],
    ["latitude 90.5", { origin: { lat: 90.5, lon: 1, label: "x" } }],
    ["longitude -180.5", { destination: { lat: 1, lon: -180.5, label: "x" } }],
  ])("rejects %s", (_name, override) => {
    expect(planRequestSchema.safeParse({ ...example, ...override }).success).toBe(false);
  });

  it("lists exactly the interval choices the UI offers", () => {
    expect(SAMPLING_INTERVALS_MI).toEqual([10, 25, 50]);
  });
});

describe("planSchema", () => {
  it("parses a valid plan and strips unknown response fields", () => {
    const parsed = planSchema.parse(rawPlan({ future_field: true }));
    expect(parsed.plan_id).toBe(MINIMAL_PLAN_ID);
    expect("future_field" in parsed).toBe(false);
    expect(parsed.routes.map((r) => r.route_id)).toEqual(["B", "A"]);
  });

  it("accepts unknown (null) weather values and levels", () => {
    const unknown = rawCheckpoint(0, {
      coord_start: 0,
      coord_end: 1,
      weather: {
        valid_time: MINIMAL_T0,
        wind_mph: null,
        gust_mph: null,
        rain_in_hr: null,
        snow_in_hr: null,
        temperature_f: null,
        weather_code: null,
      },
      risk: {
        level: null,
        factors: { wind: null, rain: null, snow: null },
        load_rule: null,
        incomplete: true,
        reasons: ["Weather data unavailable"],
      },
    });
    const stats = {
      miles_by_level: { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0 },
      unknown_mi: 50,
      avg_risk: null,
      max_level: null,
    };
    const parsed = planSchema.safeParse(planWithOnlyRoute({ checkpoints: [unknown], stats }));
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["an invalid plan id", rawPlan({ plan_id: "pln_nope" })],
    ["an empty routes list", rawPlan({ routes: [] })],
    ["a malformed timestamp", rawPlan({ created_at: "yesterday" })],
  ])("rejects %s", (_name, payload) => {
    expect(planSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects more than three routes even when everything else is consistent", () => {
    const four = rawPlan({
      routes: [rawRoute("A", 1), rawRoute("B", 2), rawRoute("C", 3), rawRoute("D", 4)],
      recommendation: {
        route_id: "A",
        status: "ok",
        decided_by: "tie",
        rationale: [],
        warnings: [],
      },
    });
    expect(planSchema.safeParse(four).success).toBe(false);
    const three = rawPlan({
      routes: [rawRoute("A", 1), rawRoute("B", 2), rawRoute("C", 3)],
      recommendation: {
        route_id: "A",
        status: "ok",
        decided_by: "tie",
        rationale: [],
        warnings: [],
      },
    });
    expect(planSchema.safeParse(three).success).toBe(true);
  });

  it("rejects a route whose stats miss a level key", () => {
    const stats = { miles_by_level: { low: 50 }, unknown_mi: 0, avg_risk: 0, max_level: "low" };
    expect(planSchema.safeParse(planWithOnlyRoute({ stats })).success).toBe(false);
  });

  describe("route invariants", () => {
    const aligned = "cumulative_mi and cumulative_s must align 1:1 with geometry.coordinates";
    const monotone = "cumulative arrays must be non-decreasing";
    const inside = "coord_start..coord_end must lie inside geometry.coordinates";

    it("rejects cumulative arrays that do not align 1:1 with the geometry", () => {
      expect(issuesOf(planSchema, planWithOnlyRoute({ cumulative_mi: [0, 50] }))).toContain(
        aligned,
      );
      expect(issuesOf(planSchema, planWithOnlyRoute({ cumulative_s: [0, 3000] }))).toContain(
        aligned,
      );
    });

    it("rejects decreasing cumulative arrays", () => {
      expect(issuesOf(planSchema, planWithOnlyRoute({ cumulative_mi: [0, 50, 25] }))).toContain(
        monotone,
      );
      expect(issuesOf(planSchema, planWithOnlyRoute({ cumulative_s: [0, 3000, 2000] }))).toContain(
        monotone,
      );
    });

    it("accepts equal consecutive cumulative values (a stop)", () => {
      const stopped = planWithOnlyRoute({ cumulative_mi: [0, 25, 25], cumulative_s: [0, 10, 10] });
      expect(planSchema.safeParse(stopped).success).toBe(true);
    });

    it("rejects checkpoint coordinate ranges outside the geometry or reversed", () => {
      const beyond = rawCheckpoint(0, { coord_start: 1, coord_end: 3 });
      const reversed = rawCheckpoint(0, { coord_start: 2, coord_end: 1 });
      expect(issuesOf(planSchema, planWithOnlyRoute({ checkpoints: [beyond] }))).toContain(inside);
      expect(issuesOf(planSchema, planWithOnlyRoute({ checkpoints: [reversed] }))).toContain(
        inside,
      );
    });

    it("rejects a LineString with fewer than two vertices even when the arrays align", () => {
      const single = {
        geometry: { type: "LineString", coordinates: [[-111.891, 40.7608]] },
        cumulative_mi: [0],
        cumulative_s: [0],
        checkpoints: [rawCheckpoint(0, { coord_start: 0, coord_end: 0 })],
      };
      expect(planSchema.safeParse(planWithOnlyRoute(single)).success).toBe(false);
    });
  });

  describe("plan invariants", () => {
    const recommendedRule =
      "exactly one route must be recommended, and it must be the rank-1 route";

    it("requires exactly one recommended route", () => {
      const none = rawPlan({
        routes: [rawRoute("B", 1, { recommended: false }), rawRoute("A", 2)],
      });
      const two = rawPlan({ routes: [rawRoute("B", 1), rawRoute("A", 2, { recommended: true })] });
      expect(issuesOf(planSchema, none)).toContain(recommendedRule);
      expect(issuesOf(planSchema, two)).toContain(recommendedRule);
    });

    it("requires the recommended route to be the first (rank 1) route", () => {
      const wrongOne = rawPlan({
        routes: [rawRoute("B", 1, { recommended: false }), rawRoute("A", 2, { recommended: true })],
      });
      expect(issuesOf(planSchema, wrongOne)).toContain(recommendedRule);
    });

    it("requires recommendation.route_id to name the first route", () => {
      const mismatch = rawPlan({
        recommendation: {
          route_id: "A",
          status: "ok",
          decided_by: "tie",
          rationale: [],
          warnings: [],
        },
      });
      expect(issuesOf(planSchema, mismatch)).toContain(
        "recommendation.route_id must name the first (rank 1) route",
      );
    });

    it("requires ranks 1..n in array order", () => {
      const skewed = rawPlan({ routes: [rawRoute("B", 1), rawRoute("A", 3)] });
      expect(issuesOf(planSchema, skewed)).toContain(
        "routes must be returned in rank order (ranks 1..n)",
      );
    });
  });
});

describe("heatmapSchema", () => {
  it("parses a valid heatmap, including null measurements for unknown cells", () => {
    const parsed = heatmapSchema.parse(rawHeatmap());
    expect(parsed.frame_count).toBe(49);
    expect(parsed.fields.snow_in_hr[0]).toBeNull();
  });

  it("allows -1 as the unknown risk marker but nothing above 4", () => {
    const ok = rawHeatmap();
    (ok["fields"] as { risk: number[] }).risk[0] = -1;
    expect(heatmapSchema.safeParse(ok).success).toBe(true);
    const bad = rawHeatmap();
    (bad["fields"] as { risk: number[] }).risk[0] = 5;
    expect(heatmapSchema.safeParse(bad).success).toBe(false);
  });

  it("pins the frame count even when every array is consistent with another count", () => {
    expect(heatmapSchema.safeParse(rawHeatmap({}, 48)).success).toBe(false);
    expect(heatmapSchema.safeParse(rawHeatmap({}, 49)).success).toBe(true);
  });

  it("pins the 60-minute step", () => {
    expect(heatmapSchema.safeParse(rawHeatmap({ step_minutes: 30 })).success).toBe(false);
  });

  it.each(HEATMAP_FIELDS)("rejects a %s array whose length is not frame_count * cells", (field) => {
    const bad = rawHeatmap();
    (bad["fields"] as Record<string, unknown[]>)[field]?.pop();
    expect(issuesOf(heatmapSchema, bad)).toContain(
      `fields.${field} must hold frame_count * cells.length = ${String(HEATMAP_FRAME_COUNT * 2)} values`,
    );
  });

  it("rejects cells outside the grid or not strictly ascending", () => {
    const message = "cells must be strictly ascending row-major indices inside the grid";
    expect(issuesOf(heatmapSchema, rawHeatmap({ cells: [0, 4] }))).toContain(message);
    expect(issuesOf(heatmapSchema, rawHeatmap({ cells: [3, 0] }))).toContain(message);
    expect(issuesOf(heatmapSchema, rawHeatmap({ cells: [0, 0] }))).toContain(message);
  });
});

describe("scenariosResponseSchema", () => {
  it("parses a bare array of scenarios", () => {
    const scenarios = [
      { id: "plains-blizzard", name: "Plains blizzard", description: "Heavy snow" },
    ];
    expect(scenariosResponseSchema.parse(scenarios)).toEqual(scenarios);
  });

  it("rejects a wrapped object and entries without an id", () => {
    expect(scenariosResponseSchema.safeParse({ scenarios: [] }).success).toBe(false);
    expect(
      scenariosResponseSchema.safeParse([{ id: "", name: "n", description: "d" }]).success,
    ).toBe(false);
  });
});

describe("riskRulesSchema", () => {
  it("parses the bundled shared/risk-rules.json", () => {
    const rules = riskRulesSchema.parse(riskRulesJson);
    expect(rules.levels.map((level) => level.id)).toEqual([...RISK_LEVELS]);
  });

  it("keeps the interval constants consistent with the shared rules file", () => {
    const rules = riskRulesSchema.parse(riskRulesJson);
    expect(rules.sampling_intervals_mi).toEqual([...SAMPLING_INTERVALS_MI]);
    expect(rules.default_sampling_interval_mi).toBe(25);
  });

  it("rejects a checkpoint spacing the API does not accept", () => {
    const withSpacing = (patch: Record<string, unknown>): unknown => ({
      ...structuredClone(riskRulesJson),
      ...patch,
    });
    expect(riskRulesSchema.safeParse(withSpacing({ sampling_intervals_mi: [10, 25, 30] })).success).toBe(
      false,
    );
    expect(riskRulesSchema.safeParse(withSpacing({ default_sampling_interval_mi: 30 })).success).toBe(
      false,
    );
    expect(riskRulesSchema.safeParse(withSpacing({})).success).toBe(true);
  });

  it("rejects a factor that does not define one band per level", () => {
    const broken = structuredClone(riskRulesJson) as { factors: { wind: { bands: unknown[] } } };
    broken.factors.wind.bands.pop();
    expect(riskRulesSchema.safeParse(broken).success).toBe(false);
  });
});

describe("problemSchema", () => {
  const example = {
    type: "https://github.com/ar27111994/weather-aware-truck-routing/blob/main/docs/api/problems.md#validation",
    title: "Invalid request",
    status: 422,
    detail: "departure_time must be within the next 120 hours",
    code: "departure_out_of_range",
    errors: [{ loc: ["body", "departure_time"], msg: "too far", type: "value_error" }],
    request_id: "req-12345678",
  };

  it("parses the contract example", () => {
    expect(problemSchema.parse(example)).toEqual(example);
  });

  it("only requires title, status and code", () => {
    expect(
      problemSchema.safeParse({ title: "Not found", status: 404, code: "plan_not_found" }).success,
    ).toBe(true);
    expect(problemSchema.safeParse({ title: "Not found", status: 404 }).success).toBe(false);
  });

  it("accepts numeric loc segments (array indices)", () => {
    const withIndex = { ...example, errors: [{ loc: ["body", "origin", 0], msg: "x", type: "t" }] };
    expect(problemSchema.safeParse(withIndex).success).toBe(true);
  });
});
