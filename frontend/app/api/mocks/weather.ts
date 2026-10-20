/**
 * Deterministic synthetic weather for the five mock scenarios, and the risk assessment + ranking
 * the mock backend applies to it. Both the plan builder (checkpoints at their ETA) and the heatmap
 * builder (every cell, every frame) sample the SAME field, so the map, the ribbon and the popovers
 * agree. Thresholds are never written here: classification goes through `lib/risk` (the JSON rules).
 */
import { at } from "../../lib/checked";
import {
  formatDurationDelta,
  formatInchesPerHour,
  formatMph,
  formatPounds,
} from "../../lib/format";
import { positionAtDistance } from "../../lib/geo";
import { RISK_RULES, classifyFactor, riskLabel, riskOrdinal } from "../../lib/risk";
import {
  RISK_FACTORS,
  RISK_LEVELS,
  type CheckpointRisk,
  type CheckpointWeather,
  type NullableRiskLevel,
  type RiskFactor,
  type RiskLevel,
  type RiskRules,
  type Scenario,
} from "../contract";
import { interpolateLinear, type DecodedRoute } from "./trips";

/** The mock scenarios, in catalog order. */
export const SCENARIO_IDS = [
  "calm",
  "mixed",
  "severe-on-fastest",
  "no-safe-route",
  "partial-unknown",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Scenario used when a plan request names none (it pretends to be the real forecast). */
export const DEFAULT_SCENARIO: ScenarioId = "mixed";

/** What `GET /scenarios` returns in the mock. */
export const SCENARIO_CATALOG: readonly Scenario[] = [
  {
    id: "calm",
    name: "Calm",
    description: "Light wind and no precipitation: every checkpoint is Low risk.",
  },
  {
    id: "mixed",
    name: "Mixed",
    description: "A rain band, a windy patch and a snow patch hit different routes.",
  },
  {
    id: "severe-on-fastest",
    name: "Severe on the fastest route",
    description: "Heavy snow sits on the fastest route, so the recommendation picks a slower one.",
  },
  {
    id: "no-safe-route",
    name: "No safe route",
    description: "A violent wind cell at the destination: every route crosses No Travel.",
  },
  {
    id: "partial-unknown",
    name: "Partial data",
    description: "Some forecast values are missing, so some checkpoints are Unknown.",
  },
];

/** Type guard for the mock scenario ids. */
export function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}

const MILES_PER_DEGREE = 69.0933;
const RADIANS = Math.PI / 180;
const HOUR_MS = 3_600_000;

/** Forecast values at one place and time (numbers only; unknown values are masked afterwards). */
export interface WeatherValues {
  readonly wind_mph: number;
  readonly gust_mph: number;
  readonly rain_in_hr: number;
  readonly snow_in_hr: number;
  readonly temperature_f: number;
  readonly weather_code: number;
}

/** Weather at `(lat, lon)`, `hours` after the heatmap start (the departure floored to the hour). */
export type WeatherField = (lat: number, lon: number, hours: number) => WeatherValues;

interface StormCell {
  readonly lat: number;
  readonly lon: number;
  readonly radiusMi: number;
  readonly wind: number;
  readonly rain: number;
  readonly snow: number;
  /** Hour (after the start) at which the cell sits exactly at `lat/lon`. */
  readonly refHour: number;
  readonly eastMph: number;
}

interface Peaks {
  readonly wind?: number;
  readonly rain?: number;
  readonly snow?: number;
}

/** A cell centred `fraction` of the way along `route`, peaking when the truck passes. */
function cellOnRoute(
  route: DecodedRoute,
  fraction: number,
  radiusFraction: number,
  peaks: Peaks,
  startOffsetH: number,
  eastMph: number,
): StormCell {
  const distance = route.distanceMi * fraction;
  const [lon, lat] = positionAtDistance(route.coords, route.cumulativeMi, distance);
  return {
    lat,
    lon,
    radiusMi: Math.max(1, route.distanceMi * radiusFraction),
    wind: peaks.wind ?? 0,
    rain: peaks.rain ?? 0,
    snow: peaks.snow ?? 0,
    refHour:
      startOffsetH + interpolateLinear(route.cumulativeMi, route.cumulativeS, distance) / 3600,
    eastMph,
  };
}

/** Provider route `index`, reusing the last route when the trip has fewer. */
function routeAt(routes: readonly DecodedRoute[], index: number): DecodedRoute {
  return at(routes, Math.min(index, routes.length - 1));
}

function cellsFor(
  scenario: ScenarioId,
  routes: readonly DecodedRoute[],
  startOffsetH: number,
): StormCell[] {
  const fastest = routeAt(routes, 0);
  switch (scenario) {
    case "calm":
      return [];
    case "mixed":
      return [
        cellOnRoute(fastest, 0.35, 0.1, { rain: 0.4 }, startOffsetH, 12),
        cellOnRoute(routeAt(routes, 1), 0.6, 0.08, { wind: 28 }, startOffsetH, 12),
        cellOnRoute(routeAt(routes, 2), 0.5, 0.09, { snow: 0.9 }, startOffsetH, 12),
      ];
    case "severe-on-fastest":
      return [cellOnRoute(fastest, 0.55, 0.08, { snow: 2.7 }, startOffsetH, 8)];
    case "no-safe-route":
      return [cellOnRoute(fastest, 1, 0.15, { wind: 64 }, startOffsetH, 0)];
    case "partial-unknown":
      return [cellOnRoute(fastest, 0.5, 0.1, { rain: 0.15 }, startOffsetH, 10)];
  }
}

const round = (value: number, decimals: number): number =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;

function weatherCode(rain: number, snow: number, wind: number): number {
  if (snow >= 0.01) return snow >= 1 ? 75 : snow >= 0.2 ? 73 : 71;
  if (rain >= 0.01) return rain >= 0.25 ? 65 : rain >= 0.1 ? 63 : 61;
  return wind >= 20 ? 3 : 1;
}

/** Builds the scenario's weather field for a trip's routes. */
export function createWeatherField(
  scenario: ScenarioId,
  routes: readonly DecodedRoute[],
  startOffsetH: number,
): WeatherField {
  const cells = cellsFor(scenario, routes, startOffsetH);
  return (lat, lon, hours) => {
    let wind = 7 + 3 * Math.sin(0.9 * lon + 0.35 * hours);
    let rain = 0;
    let snow = 0;
    for (const cell of cells) {
      const centreLat = cell.lat;
      const centreLon =
        cell.lon +
        (cell.eastMph * (hours - cell.refHour)) /
          (MILES_PER_DEGREE * Math.cos(centreLat * RADIANS));
      const dx = (lon - centreLon) * Math.cos(lat * RADIANS) * MILES_PER_DEGREE;
      const dy = (lat - centreLat) * MILES_PER_DEGREE;
      const strength = Math.exp(-((dx * dx + dy * dy) / (cell.radiusMi * cell.radiusMi)));
      wind += cell.wind * strength;
      rain += cell.rain * strength;
      snow += cell.snow * strength;
    }
    return {
      wind_mph: round(wind, 1),
      gust_mph: round(wind * 1.35, 1),
      rain_in_hr: round(rain, 3),
      snow_in_hr: round(snow, 3),
      temperature_f: round(snow > rain ? 26 : 48 + 4 * Math.sin(0.2 * hours), 1),
      weather_code: weatherCode(rain, snow, wind),
    };
  };
}

/** Whether `partial-unknown` hides ALL values of checkpoint `index`. */
export function isWeatherMissing(scenario: ScenarioId, index: number): boolean {
  return scenario === "partial-unknown" && index % 4 === 3;
}

/** Whether `partial-unknown` hides only the snow value of checkpoint `index`. */
export function isSnowMissing(scenario: ScenarioId, index: number): boolean {
  return scenario === "partial-unknown" && index % 4 !== 3 && index % 5 === 1;
}

/** A checkpoint's weather at `validTime`, with the scenario's missing values nulled. */
export function checkpointWeather(
  values: WeatherValues,
  validTime: string,
  scenario: ScenarioId,
  index: number,
): CheckpointWeather {
  if (isWeatherMissing(scenario, index)) {
    return {
      valid_time: validTime,
      wind_mph: null,
      gust_mph: null,
      rain_in_hr: null,
      snow_in_hr: null,
      temperature_f: null,
      weather_code: null,
    };
  }
  return {
    valid_time: validTime,
    wind_mph: values.wind_mph,
    gust_mph: values.gust_mph,
    rain_in_hr: values.rain_in_hr,
    snow_in_hr: isSnowMissing(scenario, index) ? null : values.snow_in_hr,
    temperature_f: values.temperature_f,
    weather_code: values.weather_code,
  };
}

/** Rounds an hour boundary up (a preceding-hour sample for ETA `ms`, DOMAIN-CONTRACT §5). */
export function ceilToHour(ms: number): number {
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

// ---------------------------------------------------------------------------------------------
// Risk assessment (a mock-side port of DOMAIN-CONTRACT §4 on top of lib/risk.classifyFactor)
// ---------------------------------------------------------------------------------------------

function highest(levels: readonly RiskLevel[]): RiskLevel | null {
  return levels.reduce<RiskLevel | null>(
    (best, level) => (best === null || riskOrdinal(level) > riskOrdinal(best) ? level : best),
    null,
  );
}

interface FactorLevels {
  readonly wind: NullableRiskLevel;
  readonly rain: NullableRiskLevel;
  readonly snow: NullableRiskLevel;
}

function loadEscalation(
  wind: number | null,
  loadLb: number,
  base: RiskLevel | null,
  rules: RiskRules,
): { level: RiskLevel; ruleId: string; text: string } | null {
  if (wind === null || base === null) return null;
  const scale = Math.round(1 / rules.factors.wind.precision);
  const tenths = Math.round(wind * scale);
  const fired = rules.load_rules
    .filter(
      (rule) =>
        rule.factor === "wind" &&
        tenths >= Math.round(rule.min_inclusive * scale) &&
        (rule.max_exclusive === undefined || tenths < Math.round(rule.max_exclusive * scale)) &&
        (rule.load_lb_min_exclusive === null || loadLb > rule.load_lb_min_exclusive) &&
        riskOrdinal(rule.result) > riskOrdinal(base),
    )
    .sort((a, b) => riskOrdinal(b.result) - riskOrdinal(a.result));
  const [rule] = fired;
  if (!rule) return null;
  const threshold =
    rule.load_lb_min_exclusive === null ? "" : ` > ${formatPounds(rule.load_lb_min_exclusive)}`;
  return {
    level: rule.result,
    ruleId: rule.id,
    text: `Load ${formatPounds(loadLb)}${threshold} escalates to ${riskLabel(rule.result)} (${rule.id})`,
  };
}

function factorReason(
  factor: RiskFactor,
  value: number | null,
  level: NullableRiskLevel,
  rules: RiskRules,
): string {
  const label = rules.factors[factor].label;
  if (value === null || level === null) return `${label} data unavailable`;
  const shown = factor === "wind" ? formatMph(value) : formatInchesPerHour(value);
  return `${label} ${shown} (${riskLabel(level)})`;
}

interface Evaluation {
  readonly values: {
    readonly wind: number | null;
    readonly rain: number | null;
    readonly snow: number | null;
  };
  readonly factors: FactorLevels;
  readonly known: number;
  readonly escalation: ReturnType<typeof loadEscalation>;
  readonly level: NullableRiskLevel;
}

function evaluate(weather: CheckpointWeather, loadLb: number, rules: RiskRules): Evaluation {
  const values = { wind: weather.wind_mph, rain: weather.rain_in_hr, snow: weather.snow_in_hr };
  const factors: FactorLevels = {
    wind: classifyFactor("wind", values.wind, rules),
    rain: classifyFactor("rain", values.rain, rules),
    snow: classifyFactor("snow", values.snow, rules),
  };
  const known = RISK_FACTORS.flatMap((factor) => {
    const level = factors[factor];
    return level === null ? [] : [level];
  });
  const base = highest(known);
  const escalation = loadEscalation(values.wind, loadLb, base, rules);
  return { values, factors, known: known.length, escalation, level: escalation?.level ?? base };
}

/** Just the risk level of a checkpoint's weather (the cheap path the heatmap takes per cell and frame). */
export function assessLevel(
  weather: CheckpointWeather,
  loadLb: number,
  rules: RiskRules = RISK_RULES,
): NullableRiskLevel {
  return evaluate(weather, loadLb, rules).level;
}

/** The risk of a checkpoint's weather for a load (levels, escalation rule, reasons). */
export function assessWeather(
  weather: CheckpointWeather,
  loadLb: number,
  rules: RiskRules = RISK_RULES,
): CheckpointRisk {
  const { values, factors, known, escalation, level } = evaluate(weather, loadLb, rules);
  const reasons = RISK_FACTORS.map((factor) =>
    factorReason(factor, values[factor], factors[factor], rules),
  );
  return {
    level,
    factors,
    load_rule: escalation?.ruleId ?? null,
    incomplete: known < RISK_FACTORS.length,
    reasons: escalation ? [...reasons, escalation.text] : reasons,
  };
}

/** The ordinal the heatmap stores for a risk level (`-1` = unknown). */
export function heatmapRiskValue(level: NullableRiskLevel): number {
  return level === null ? -1 : RISK_LEVELS.indexOf(level);
}

// ---------------------------------------------------------------------------------------------
// Ranking (a mock-side port of DOMAIN-CONTRACT §8)
// ---------------------------------------------------------------------------------------------

/** A route as the ranker sees it. */
export interface RankCandidate {
  readonly routeId: string;
  readonly label: string;
  readonly durationS: number;
  readonly noTravelMi: number;
  readonly severeMi: number;
  readonly highMi: number;
  readonly avgRisk: number | null;
  readonly unknownMi: number;
}

/** The ranking result in the shape the recommendation needs. */
export interface Ranking {
  readonly order: readonly string[];
  readonly status: "ok" | "no_safe_route";
  readonly decidedBy: "no_travel_mi" | "severe_mi" | "high_mi" | "avg_risk" | "duration_s" | "tie";
  readonly rationale: string[];
  readonly warnings: string[];
}

const KEY_NAMES = ["no_travel_mi", "severe_mi", "high_mi", "avg_risk", "duration_s"] as const;

function rankKey(candidate: RankCandidate): number[] {
  return [
    Math.round(candidate.noTravelMi * 10),
    Math.round(candidate.severeMi * 10),
    Math.round(candidate.highMi * 10),
    candidate.avgRisk === null ? Number.POSITIVE_INFINITY : Math.round(candidate.avgRisk * 1000),
    Math.round(candidate.durationS),
  ];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const position = a.findIndex((value, index) => value !== b[index]);
  return position === -1 ? 0 : at(a, position) - at(b, position);
}

/** Orders routes by (no travel, severe, high miles, average risk, duration), then provider order. */
export function rankRoutes(candidates: readonly RankCandidate[]): Ranking {
  const ranked = candidates
    .map((candidate, order) => ({ candidate, order, key: rankKey(candidate) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.order - b.order);
  const [best, second] = ranked;
  const fastest = Math.min(...candidates.map((candidate) => candidate.durationS));
  const decisive = best && second ? compareKeys(best.key, second.key) : 0;
  const decidedBy =
    best && second && decisive !== 0
      ? at(
          KEY_NAMES,
          best.key.findIndex((value, index) => value !== at(second.key, index)),
        )
      : "tie";
  const rationale = ranked.map(({ candidate }, position) => {
    const delta = candidate.durationS - fastest;
    const timing =
      delta === 0 ? "the fastest option" : `${formatDurationDelta(delta)} vs the fastest option`;
    const prefix =
      position === 0
        ? `${candidate.label} is recommended`
        : `${candidate.label} ranks #${String(position + 1)}`;
    return `${prefix}: ${candidate.noTravelMi.toFixed(1)} no-travel, ${candidate.severeMi.toFixed(1)} severe and ${candidate.highMi.toFixed(1)} high miles; ${timing}`;
  });
  const bestCandidate = best?.candidate;
  const warnings: string[] = [];
  if (bestCandidate && bestCandidate.noTravelMi > 0)
    warnings.push("Every route crosses No Travel conditions. Do not depart.");
  if (bestCandidate && bestCandidate.unknownMi > 0) {
    warnings.push(
      `${bestCandidate.label} has ${bestCandidate.unknownMi.toFixed(1)} miles with unknown weather.`,
    );
  }
  return {
    order: ranked.map(({ candidate }) => candidate.routeId),
    status: bestCandidate && bestCandidate.noTravelMi > 0 ? "no_safe_route" : "ok",
    decidedBy,
    rationale,
    warnings,
  };
}
