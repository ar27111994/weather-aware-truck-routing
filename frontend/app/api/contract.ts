/**
 * Hand-written mirror of `.planning/API-CONTRACT.md` (`/api/v1`).
 *
 * Types are derived from the Zod schemas (`z.infer`), so each response shape is written exactly once
 * and the runtime validation can never drift from the compile-time types. Names follow the contract
 * so the later swap to OpenAPI-generated types is a mechanical re-export.
 *
 * Structural invariants that consumers rely on (aligned arrays, indices inside the geometry, rank
 * order, exactly one recommended route, heatmap array lengths) are part of the schemas: a response
 * that breaks one becomes a typed `ApiError("invalid_response")` instead of a crash in the UI.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------------------------

/** Risk levels in ascending severity. `null` (not `"low"`) means the weather is unknown. */
export const RISK_LEVELS = ["low", "moderate", "high", "severe", "no_travel"] as const;

/** One of the five risk levels (never unknown; see {@link NullableRiskLevel}). */
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** A risk level, or `null` when the underlying weather data is missing. */
export const nullableRiskLevelSchema = riskLevelSchema.nullable();
export type NullableRiskLevel = z.infer<typeof nullableRiskLevelSchema>;

/** Checkpoint spacing choices in miles, as the user can pick them. */
export const SAMPLING_INTERVALS_MI = [10, 25, 50] as const;
export type SamplingIntervalMi = (typeof SAMPLING_INTERVALS_MI)[number];

/** Number of hourly frames in a corridor heatmap (forecast hours 0..48 from departure). */
export const HEATMAP_FRAME_COUNT = 49;
/** Minutes between two heatmap frames. */
export const HEATMAP_STEP_MINUTES = 60;

/** `"pln_"` followed by a 26-character Crockford-base32 ULID. */
const PLAN_ID_PATTERN = /^pln_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether `value` has the shape of a plan id (guards share-link input before any request). */
export function isPlanId(value: unknown): value is string {
  return typeof value === "string" && PLAN_ID_PATTERN.test(value);
}

const planIdSchema = z.string().regex(PLAN_ID_PATTERN, "Not a plan id (pln_ + 26-char ULID)");
/** RFC 3339 instant in UTC (`...Z`). */
const utcTimestampSchema = z.iso.datetime();
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
const milesSchema = z.number().nonnegative();
const nonNegativeIntSchema = z.number().int().nonnegative();

/** A `[lon, lat]` pair in WGS84 degrees (GeoJSON order). */
const lonLatSchema = z.tuple([longitudeSchema, latitudeSchema]);
export type LonLat = z.infer<typeof lonLatSchema>;

// ---------------------------------------------------------------------------------------------
// Errors (RFC 9457 problem+json)
// ---------------------------------------------------------------------------------------------

/** One field-level validation failure inside a problem document. */
export const problemFieldErrorSchema = z.object({
  loc: z.array(z.union([z.string(), z.number()])),
  msg: z.string(),
  type: z.string(),
});
export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

/** The `application/problem+json` body every non-2xx API response carries. */
export const problemSchema = z.object({
  type: z.string().optional(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string(),
  errors: z.array(problemFieldErrorSchema).optional(),
  request_id: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

// ---------------------------------------------------------------------------------------------
// GET /geocode
// ---------------------------------------------------------------------------------------------

/**
 * One autocomplete suggestion. `region`, `country` and `country_code` are nullable on purpose: the
 * contract example shows strings, but a provider omits them for state- or country-level hits, and a
 * single missing field must not reject the whole suggestion list.
 */
export const geocodeResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  name: z.string(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  country_code: z.string().nullable(),
  kind: z.string(),
  lat: latitudeSchema,
  lon: longitudeSchema,
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

/** `GET /geocode` response. */
export const geocodeResponseSchema = z.object({
  query: z.string(),
  results: z.array(geocodeResultSchema),
});
export type GeocodeResponse = z.infer<typeof geocodeResponseSchema>;

// ---------------------------------------------------------------------------------------------
// POST /plans (request) and the Plan response
// ---------------------------------------------------------------------------------------------

/** An origin or destination: coordinates plus the user-visible label. */
export const planLocationSchema = z.object({
  lat: latitudeSchema,
  lon: longitudeSchema,
  label: z.string().min(1).max(200),
});
export type PlanLocation = z.infer<typeof planLocationSchema>;

/** One of the {@link SAMPLING_INTERVALS_MI}: the closed set the API accepts and echoes. */
export const samplingIntervalSchema = z.literal(SAMPLING_INTERVALS_MI);

/**
 * `POST /plans` body (also the normalized echo inside a Plan). Structural validation: the load
 * range lives in `shared/risk-rules.json` and is enforced by the form and the server, never
 * duplicated here; the checkpoint spacing is the contract's closed set, typed as a literal union
 * so a form cannot build an invalid request.
 */
export const planRequestSchema = z.object({
  origin: planLocationSchema,
  destination: planLocationSchema,
  departure_time: utcTimestampSchema,
  load_weight_lb: nonNegativeIntSchema,
  sampling_interval_mi: samplingIntervalSchema,
  scenario: z.string().nullable().optional(),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;

/** Where each plan input came from; `attribution` strings must be shown to the user. */
export const planSourcesSchema = z.object({
  routing: z.string(),
  weather: z.string(),
  weather_model: z.string(),
  scenario: z.string().nullable(),
  attribution: z.array(z.string()),
});
export type PlanSources = z.infer<typeof planSourcesSchema>;

/** The forecast values at a checkpoint; `null` marks a missing value. */
export const checkpointWeatherSchema = z.object({
  valid_time: utcTimestampSchema,
  wind_mph: z.number().nullable(),
  gust_mph: z.number().nullable(),
  rain_in_hr: z.number().nullable(),
  snow_in_hr: z.number().nullable(),
  temperature_f: z.number().nullable(),
  weather_code: z.number().int().nullable(),
});
export type CheckpointWeather = z.infer<typeof checkpointWeatherSchema>;

/** Risk assessment of one checkpoint. `level: null` means unknown. */
export const checkpointRiskSchema = z.object({
  level: nullableRiskLevelSchema,
  factors: z.object({
    wind: nullableRiskLevelSchema,
    rain: nullableRiskLevelSchema,
    snow: nullableRiskLevelSchema,
  }),
  load_rule: z.string().nullable(),
  incomplete: z.boolean(),
  reasons: z.array(z.string()),
});
export type CheckpointRisk = z.infer<typeof checkpointRiskSchema>;

/**
 * A sampled point on a route. `coord_start..coord_end` (inclusive) index the route geometry (and
 * `cumulative_*`): the stretch this checkpoint owns, used to paint the risk ribbon.
 */
export const checkpointSchema = z.object({
  index: nonNegativeIntSchema,
  distance_mi: milesSchema,
  lat: latitudeSchema,
  lon: longitudeSchema,
  eta: utcTimestampSchema,
  utc_offset_s: z.number().int(),
  timezone: z.string(),
  owned_mi: milesSchema,
  coord_start: nonNegativeIntSchema,
  coord_end: nonNegativeIntSchema,
  weather: checkpointWeatherSchema,
  risk: checkpointRiskSchema,
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

/** Miles per risk level (all five keys always present) plus the unknown remainder. */
export const routeStatsSchema = z.object({
  miles_by_level: z.object({
    low: milesSchema,
    moderate: milesSchema,
    high: milesSchema,
    severe: milesSchema,
    no_travel: milesSchema,
  }),
  unknown_mi: milesSchema,
  avg_risk: z.number().min(0).max(4).nullable(),
  max_level: nullableRiskLevelSchema,
});
export type RouteStats = z.infer<typeof routeStatsSchema>;

const geometrySchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(lonLatSchema).min(2),
});

function isNonDecreasing(values: readonly number[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < previous) return false;
    previous = value;
  }
  return true;
}

function isStrictlyAscending(values: readonly number[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value <= previous) return false;
    previous = value;
  }
  return true;
}

/** One route option, ranked, with its sampled checkpoints. */
export const routeSchema = z
  .object({
    route_id: z.string().min(1),
    label: z.string(),
    summary: z.string(),
    distance_mi: milesSchema,
    duration_s: z.number().nonnegative(),
    departure_time: utcTimestampSchema,
    arrival_time: utcTimestampSchema,
    geometry: geometrySchema,
    cumulative_mi: z.array(z.number()),
    cumulative_s: z.array(z.number()),
    checkpoints: z.array(checkpointSchema).min(1),
    stats: routeStatsSchema,
    rank: z.number().int().min(1),
    recommended: z.boolean(),
  })
  .superRefine((route, context) => {
    const vertexCount = route.geometry.coordinates.length;
    if (route.cumulative_mi.length !== vertexCount || route.cumulative_s.length !== vertexCount) {
      context.addIssue({
        code: "custom",
        path: ["cumulative_mi"],
        message: "cumulative_mi and cumulative_s must align 1:1 with geometry.coordinates",
      });
    }
    if (!isNonDecreasing(route.cumulative_mi) || !isNonDecreasing(route.cumulative_s)) {
      context.addIssue({
        code: "custom",
        path: ["cumulative_mi"],
        message: "cumulative arrays must be non-decreasing",
      });
    }
    route.checkpoints.forEach((checkpoint, position) => {
      if (checkpoint.coord_start > checkpoint.coord_end || checkpoint.coord_end >= vertexCount) {
        context.addIssue({
          code: "custom",
          path: ["checkpoints", position, "coord_end"],
          message: "coord_start..coord_end must lie inside geometry.coordinates",
        });
      }
    });
  });
export type Route = z.infer<typeof routeSchema>;

/** Why the recommended route won: the first ranking key that separated the top two routes. */
export const DECIDED_BY = [
  "no_travel_mi",
  "severe_mi",
  "high_mi",
  "avg_risk",
  "duration_s",
  "tie",
] as const;

/** The recommendation. `no_safe_route` means even the best route crosses No Travel miles. */
export const recommendationSchema = z.object({
  route_id: z.string().min(1),
  status: z.enum(["ok", "no_safe_route"]),
  decided_by: z.enum(DECIDED_BY),
  rationale: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/** `POST /plans` (201 or 200) and `GET /plans/{plan_id}` response. */
export const planSchema = z
  .object({
    plan_id: planIdSchema,
    created_at: utcTimestampSchema,
    expires_at: utcTimestampSchema,
    request: planRequestSchema,
    sources: planSourcesSchema,
    routes: z.array(routeSchema).min(1).max(3),
    recommendation: recommendationSchema,
    warnings: z.array(z.string()),
  })
  .superRefine((plan, context) => {
    const recommended = plan.routes.filter((route) => route.recommended);
    const [first] = plan.routes;
    if (recommended.length !== 1 || recommended[0] !== first) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "exactly one route must be recommended, and it must be the rank-1 route",
      });
    }
    if (first?.route_id !== plan.recommendation.route_id) {
      context.addIssue({
        code: "custom",
        path: ["recommendation", "route_id"],
        message: "recommendation.route_id must name the first (rank 1) route",
      });
    }
    if (plan.routes.some((route, position) => route.rank !== position + 1)) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "routes must be returned in rank order (ranks 1..n)",
      });
    }
  });
export type Plan = z.infer<typeof planSchema>;

// ---------------------------------------------------------------------------------------------
// GET /plans/{plan_id}/heatmap
// ---------------------------------------------------------------------------------------------

/** Regular lat/lon grid; `cells` index it row-major (`row * cols + col`). */
export const heatmapGridSchema = z.object({
  lat0: latitudeSchema,
  lon0: longitudeSchema,
  dlat: z.number().positive(),
  dlon: z.number().positive(),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
});
export type HeatmapGrid = z.infer<typeof heatmapGridSchema>;

/** The numeric field names a heatmap carries, in contract order. */
export const HEATMAP_FIELDS = ["risk", "wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr"] as const;
export type HeatmapField = (typeof HEATMAP_FIELDS)[number];

const measurementSchema = z.array(z.number().nullable());

/**
 * `GET /plans/{plan_id}/heatmap`: forecast fields over the corridor grid. Every field is
 * frame-major with `frame_count * cells.length` entries; `risk` holds ordinals 0..4 or -1 (unknown),
 * and the other fields hold `null` where the forecast is unknown.
 */
export const heatmapSchema = z
  .object({
    plan_id: planIdSchema,
    start_time: utcTimestampSchema,
    frame_count: z.literal(HEATMAP_FRAME_COUNT),
    step_minutes: z.literal(HEATMAP_STEP_MINUTES),
    grid: heatmapGridSchema,
    cells: z.array(nonNegativeIntSchema),
    fields: z.object({
      risk: z.array(z.number().int().min(-1).max(4)),
      wind_mph: measurementSchema,
      gust_mph: measurementSchema,
      rain_in_hr: measurementSchema,
      snow_in_hr: measurementSchema,
    }),
    load_weight_lb: nonNegativeIntSchema,
    sources: planSourcesSchema,
    generated_at: utcTimestampSchema,
  })
  .superRefine((heatmap, context) => {
    const expectedLength = heatmap.frame_count * heatmap.cells.length;
    for (const field of HEATMAP_FIELDS) {
      if (heatmap.fields[field].length !== expectedLength) {
        context.addIssue({
          code: "custom",
          path: ["fields", field],
          message: `fields.${field} must hold frame_count * cells.length = ${String(expectedLength)} values`,
        });
      }
    }
    const cellCount = heatmap.grid.rows * heatmap.grid.cols;
    const inGrid = heatmap.cells.every((cell) => cell < cellCount);
    if (!inGrid || !isStrictlyAscending(heatmap.cells)) {
      context.addIssue({
        code: "custom",
        path: ["cells"],
        message: "cells must be strictly ascending row-major indices inside the grid",
      });
    }
  });
export type Heatmap = z.infer<typeof heatmapSchema>;

// ---------------------------------------------------------------------------------------------
// GET /scenarios and GET /rules
// ---------------------------------------------------------------------------------------------

/** A demo weather scenario (deterministic synthetic weather, never a forecast). */
export const scenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

/** `GET /scenarios` response: a bare array. */
export const scenariosResponseSchema = z.array(scenarioSchema);

const bandSchema = z.object({
  level: riskLevelSchema,
  min_inclusive: z.number().optional(),
  min_exclusive: z.number().optional(),
  max_inclusive: z.number().optional(),
  max_exclusive: z.number().optional(),
});
export type RiskBand = z.infer<typeof bandSchema>;

/** The three weather factors a checkpoint is classified on. */
export const RISK_FACTORS = ["wind", "rain", "snow"] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

const factorRulesSchema = z.object({
  label: z.string(),
  unit: z.string(),
  precision: z.number().positive(),
  bands: z.array(bandSchema).length(RISK_LEVELS.length),
  brief_labels: z.array(z.string()).length(RISK_LEVELS.length),
});

const loadRuleSchema = z.object({
  id: z.string(),
  factor: z.enum(RISK_FACTORS),
  min_inclusive: z.number(),
  max_exclusive: z.number().optional(),
  load_lb_min_exclusive: z.number().nullable(),
  result: riskLevelSchema,
  brief_text: z.string(),
});
export type LoadRule = z.infer<typeof loadRuleSchema>;

/** The `shared/risk-rules.json` document, as served by `GET /rules` and bundled in the app. */
export const riskRulesSchema = z.object({
  version: z.string(),
  levels: z.array(z.object({ id: riskLevelSchema, ordinal: z.number().int(), label: z.string() })),
  factors: z.object({ wind: factorRulesSchema, rain: factorRulesSchema, snow: factorRulesSchema }),
  load_rules: z.array(loadRuleSchema),
  ranking: z.object({
    keys: z.array(z.string()),
    tolerances: z.object({ miles: z.number(), avg_risk: z.number(), duration_s: z.number() }),
    brief_order: z.array(z.string()),
    extension_note: z.string(),
  }),
  load_limits_lb: z.object({ min: z.number().int(), max: z.number().int() }),
  assumed_tare_lb: z.number().int(),
  sampling_intervals_mi: z.array(samplingIntervalSchema),
  default_sampling_interval_mi: samplingIntervalSchema,
});
export type RiskRules = z.infer<typeof riskRulesSchema>;
