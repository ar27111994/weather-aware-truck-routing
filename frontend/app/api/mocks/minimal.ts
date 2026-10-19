/**
 * Tiny, hand-shaped payload builders for unit tests of the contract and the client.
 *
 * The `raw*` builders return untyped objects a test can corrupt on purpose; the `minimal*` builders
 * return the same payloads parsed through the real schemas (so they are valid by construction).
 * The realistic, route-based fixtures live in `plan-builder.ts` and `heatmap-builder.ts`.
 */
import riskRulesJson from "../../../../shared/risk-rules.json";
import {
  HEATMAP_FRAME_COUNT,
  HEATMAP_STEP_MINUTES,
  heatmapSchema,
  planSchema,
  riskRulesSchema,
  type Heatmap,
  type Plan,
  type RiskRules,
} from "../contract";

/** A syntactically valid plan id used by every minimal payload. */
export const MINIMAL_PLAN_ID = "pln_01JABCDEFGHJKMNPQRSTVWXYZ0";
/** Departure (and every ETA) of the minimal payloads. */
export const MINIMAL_T0 = "2026-10-20T14:00:00Z";

/** A checkpoint at vertex `index`, owning vertices `index..index + 1`; override any field. */
export function rawCheckpoint(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    index,
    distance_mi: index * 25,
    lat: 40.7608,
    lon: -111.891,
    eta: MINIMAL_T0,
    utc_offset_s: -21600,
    timezone: "America/Denver",
    owned_mi: 12.5,
    coord_start: index,
    coord_end: index + 1,
    weather: {
      valid_time: MINIMAL_T0,
      wind_mph: 12.3,
      gust_mph: 21,
      rain_in_hr: 0,
      snow_in_hr: 0,
      temperature_f: 48.2,
      weather_code: 3,
    },
    risk: {
      level: "low",
      factors: { wind: "low", rain: "low", snow: "low" },
      load_rule: null,
      incomplete: false,
      reasons: ["Wind 12.3 mph (Low)"],
    },
    ...overrides,
  };
}

/** A three-vertex, two-checkpoint route; `rank` 1 is recommended. */
export function rawRoute(
  id: string,
  rank: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    route_id: id,
    label: `Route ${id}`,
    summary: "via I-80 E",
    distance_mi: 50,
    duration_s: 3000,
    departure_time: MINIMAL_T0,
    arrival_time: "2026-10-20T14:50:00Z",
    geometry: {
      type: "LineString",
      coordinates: [
        [-111.891, 40.7608],
        [-111.5, 40.8],
        [-111.0, 40.9],
      ],
    },
    cumulative_mi: [0, 25, 50],
    cumulative_s: [0, 1500, 3000],
    checkpoints: [rawCheckpoint(0), rawCheckpoint(1)],
    stats: {
      miles_by_level: { low: 50, moderate: 0, high: 0, severe: 0, no_travel: 0 },
      unknown_mi: 0,
      avg_risk: 0,
      max_level: "low",
    },
    rank,
    recommended: rank === 1,
    ...overrides,
  };
}

/** A plan with routes `B` (rank 1, recommended) and `A` (rank 2). */
export function rawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_id: MINIMAL_PLAN_ID,
    created_at: MINIMAL_T0,
    expires_at: "2026-10-27T14:00:00Z",
    request: {
      origin: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" },
      destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
      departure_time: MINIMAL_T0,
      load_weight_lb: 38000,
      sampling_interval_mi: 25,
      scenario: null,
    },
    sources: {
      routing: "valhalla",
      weather: "open-meteo",
      weather_model: "best_match",
      scenario: null,
      attribution: ["© OpenStreetMap contributors"],
    },
    routes: [rawRoute("B", 1), rawRoute("A", 2)],
    recommendation: {
      route_id: "B",
      status: "ok",
      decided_by: "severe_mi",
      rationale: ["Route B avoids 12.5 severe miles that Route A crosses"],
      warnings: [],
    },
    warnings: [],
    ...overrides,
  };
}

/** A heatmap over a 2x2 grid with cells 0 and 3, sized for `frameCount` frames of every field. */
export function rawHeatmap(
  overrides: Record<string, unknown> = {},
  frameCount = HEATMAP_FRAME_COUNT,
): Record<string, unknown> {
  const cells = [0, 3];
  const length = frameCount * cells.length;
  const filled = (value: number | null): (number | null)[] => Array.from({ length }, () => value);
  return {
    plan_id: MINIMAL_PLAN_ID,
    start_time: MINIMAL_T0,
    frame_count: frameCount,
    step_minutes: HEATMAP_STEP_MINUTES,
    grid: { lat0: 38.5, lon0: -112.5, dlat: 0.25, dlon: 0.25, rows: 2, cols: 2 },
    cells,
    fields: {
      risk: filled(0),
      wind_mph: filled(12.3),
      gust_mph: filled(21),
      rain_in_hr: filled(0),
      snow_in_hr: filled(null),
    },
    load_weight_lb: 38000,
    sources: rawPlan()["sources"],
    generated_at: MINIMAL_T0,
    ...overrides,
  };
}

/** {@link rawPlan} parsed through the real schema. */
export function minimalPlan(): Plan {
  return planSchema.parse(rawPlan());
}

/** {@link rawHeatmap} parsed through the real schema. */
export function minimalHeatmap(): Heatmap {
  return heatmapSchema.parse(rawHeatmap());
}

/** The bundled `shared/risk-rules.json`, parsed through the real schema. */
export function minimalRules(): RiskRules {
  return riskRulesSchema.parse(riskRulesJson);
}
