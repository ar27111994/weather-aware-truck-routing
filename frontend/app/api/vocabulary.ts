/**
 * The contract's closed sets of words and numbers, with no schema library attached.
 *
 * `contract.ts` builds its Zod schemas from these lists, and re-exports them, so the rest of the app
 * keeps importing them from there. The pages that must stay small (the methodology page and the
 * shell around every page) import them from here instead: a value import from `contract.ts` would
 * carry the whole schema library into the first download of every visitor (N1).
 */

/** Risk levels in ascending severity. `null` (not `"low"`) means the weather is unknown. */
export const RISK_LEVELS = ["low", "moderate", "high", "severe", "no_travel"] as const;

/** Checkpoint spacing choices in miles, as the user can pick them. */
export const SAMPLING_INTERVALS_MI = [10, 25, 50] as const;
/** One of the {@link SAMPLING_INTERVALS_MI}. */
export type SamplingIntervalMi = (typeof SAMPLING_INTERVALS_MI)[number];

/** Number of hourly frames in a corridor heatmap (forecast hours 0..48 from departure). */
export const HEATMAP_FRAME_COUNT = 49;
/** Minutes between two heatmap frames. */
export const HEATMAP_STEP_MINUTES = 60;

/**
 * Why the recommended route won, in the order of the domain's `DecidedBy`
 * (`backend/src/haulcast/domain/scoring.py`): the first ranking key on which the top two routes
 * differ (`coverage` is D-31: weather is missing for more than 10% of a route's miles), `tie` when
 * they match on every key, or `only_route` when the plan has a single route and there is nothing
 * to compare.
 */
export const DECIDED_BY = [
  "no_travel_mi",
  "coverage",
  "severe_mi",
  "high_mi",
  "avg_risk",
  "duration_s",
  "tie",
  "only_route",
] as const;
/** One of the {@link DECIDED_BY} values. */
export type DecidedBy = (typeof DECIDED_BY)[number];

/** The numeric field names a heatmap carries, in contract order. */
export const HEATMAP_FIELDS = ["risk", "wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr"] as const;
/** One of the {@link HEATMAP_FIELDS}. */
export type HeatmapField = (typeof HEATMAP_FIELDS)[number];

/** The three weather factors a checkpoint is classified on. */
export const RISK_FACTORS = ["wind", "rain", "snow"] as const;
/** One of the {@link RISK_FACTORS}. */
export type RiskFactor = (typeof RISK_FACTORS)[number];
