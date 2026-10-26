/**
 * Builds contract-shaped plans and heatmaps from the recorded real route geometries. Everything is
 * deterministic: the same request always yields the same plan id and the same numbers, and the
 * plan's checkpoints and the heatmap sample the SAME scenario weather field.
 */
import { at } from "../../lib/checked";
import { boundingBox, haversineMiles, positionAtDistance } from "../../lib/geo";
import { riskOrdinal } from "../../lib/risk";
import {
  HEATMAP_FRAME_COUNT,
  HEATMAP_STEP_MINUTES,
  SCENARIO_NOTICE,
  type Checkpoint,
  type Heatmap,
  type LonLat,
  type Plan,
  type PlanRequest,
  type RiskLevel,
  type Route,
  type RouteStats,
} from "../contract";
import { findTrip, interpolateLinear, type DecodedRoute, type Trip } from "./trips";
import {
  DEFAULT_SCENARIO,
  assessLevel,
  assessWeather,
  ceilToHour,
  checkpointWeather,
  createWeatherField,
  heatmapRiskValue,
  isScenarioId,
  rankRoutes,
  type ScenarioId,
  type WeatherField,
} from "./weather";

/**
 * What the API says of a route that has checkpoints without weather: the backend's
 * `weather_gap_warning` (`services/plan_assembly.py`), word for word (R4-11).
 */
function weatherGapWarning(
  label: string,
  unknown: number,
  total: number,
  unknownMi: number,
): string {
  return `${label}: weather is missing at ${String(unknown)} of ${String(total)} checkpoints (${unknownMi.toFixed(1)} mi); that stretch's risk is shown as unknown.`;
}

const HOUR_MS = 3_600_000;
const EPSILON_MI = 0.01;
const CORRIDOR_MI = 25;
const MAX_HEATMAP_CELLS = 200;
const MILES_PER_DEGREE = 69.0933;
const RADIANS = Math.PI / 180;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Why the mock cannot answer a plan request (the handlers turn these into 422 problems). */
export type FixtureErrorCode = "no_route_found" | "unknown_scenario" | "same_origin_destination";

/** A plan request the mock backend rejects for a domain reason. */
export class FixtureError extends Error {
  readonly code: FixtureErrorCode;

  constructor(code: FixtureErrorCode, message: string) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
  }
}

/** Everything derived from a request that plans and heatmaps share. */
export interface World {
  readonly request: PlanRequest;
  readonly trip: Trip;
  readonly scenario: ScenarioId;
  /** The scenario the request named (`null` = the pretend-real forecast). */
  readonly requestedScenario: string | null;
  readonly departureMs: number;
  /** Departure floored to the hour: heatmap frame 0. */
  readonly startMs: number;
  readonly field: WeatherField;
}

const round = (value: number, decimals: number): number =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/** Approximate US time zone from longitude (good enough for the recorded trips). */
export function usZone(lon: number): string {
  const zones: readonly (readonly [number, string])[] = [
    [-114.5, "America/Los_Angeles"],
    [-102, "America/Denver"],
    [-87, "America/Chicago"],
  ];
  return zones.find(([limit]) => lon < limit)?.[1] ?? "America/New_York";
}

/** The UTC offset of `timezone` at `instantMs`, in seconds (DST-aware, via Intl). */
export function utcOffsetSeconds(timezone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instantMs);
  const field = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const wallClockMs = Date.UTC(
    Number(field["year"]),
    Number(field["month"]) - 1,
    Number(field["day"]),
    Number(field["hour"]),
    Number(field["minute"]),
    Number(field["second"]),
  );
  return Math.round((wallClockMs - Math.floor(instantMs / 1000) * 1000) / 1000);
}

function resolveScenario(requested: string | null): ScenarioId {
  if (requested === null) return DEFAULT_SCENARIO;
  if (isScenarioId(requested)) return requested;
  throw new FixtureError("unknown_scenario", `Unknown scenario "${requested}"`);
}

/** Resolves the request against the recorded trips and scenario catalog. */
export function buildWorld(request: PlanRequest): World {
  const requestedScenario = request.scenario ?? null;
  const scenario = resolveScenario(requestedScenario);
  const { origin, destination } = request;
  if (haversineMiles([origin.lon, origin.lat], [destination.lon, destination.lat]) < 1) {
    throw new FixtureError(
      "same_origin_destination",
      "Origin and destination must be at least 1 mile apart",
    );
  }
  const trip = findTrip(origin, destination);
  if (!trip) {
    throw new FixtureError(
      "no_route_found",
      `The mock API has no recorded route from ${origin.label} to ${destination.label}`,
    );
  }
  const departureMs = Date.parse(request.departure_time);
  const startMs = Math.floor(departureMs / HOUR_MS) * HOUR_MS;
  return {
    request,
    trip,
    scenario,
    requestedScenario,
    departureMs,
    startMs,
    field: createWeatherField(scenario, trip, (departureMs - startMs) / HOUR_MS),
  };
}

/** Checkpoint distances: 0, I, 2I, ... while below the length, then the destination. */
export function checkpointDistances(lengthMi: number, intervalMi: number): number[] {
  const distances: number[] = [];
  for (let step = 0; step * intervalMi < lengthMi - EPSILON_MI; step += 1)
    distances.push(step * intervalMi);
  return [...distances, lengthMi];
}

function buildCheckpoints(world: World, provider: DecodedRoute): Checkpoint[] {
  const distances = checkpointDistances(provider.distanceMi, world.request.sampling_interval_mi);
  const midpoints = distances
    .slice(1)
    .map((distance, index) => (at(distances, index) + distance) / 2);
  const boundaries = [0, ...midpoints, provider.distanceMi];
  const tenths = boundaries.map((boundary) => Math.round(boundary * 10));
  return distances.map((distance, index) => {
    const [lon, lat] = positionAtDistance(provider.coords, provider.cumulativeMi, distance);
    const elapsedS = interpolateLinear(provider.cumulativeMi, provider.cumulativeS, distance);
    const etaMs = Math.round((world.departureMs + elapsedS * 1000) / 1000) * 1000;
    const timezone = usZone(lon);
    const values = world.field(lat, lon, (etaMs - world.startMs) / HOUR_MS);
    const weather = checkpointWeather(values, iso(ceilToHour(etaMs)), world.scenario, index);
    return {
      index,
      distance_mi: round(distance, 3),
      lat: round(lat, 5),
      lon: round(lon, 5),
      eta: iso(etaMs),
      utc_offset_s: utcOffsetSeconds(timezone, etaMs),
      timezone,
      owned_mi: (at(tenths, index + 1) - at(tenths, index)) / 10,
      coord_start: provider.cumulativeMi.findLastIndex((miles) => miles <= at(boundaries, index)),
      coord_end: provider.cumulativeMi.findLastIndex((miles) => miles <= at(boundaries, index + 1)),
      weather,
      risk: assessWeather(weather, world.request.load_weight_lb),
    };
  });
}

/** Miles by level, unknown miles, mile-weighted average risk and the worst level (DOMAIN-CONTRACT §7). */
export function summarizeCheckpoints(checkpoints: readonly Checkpoint[]): RouteStats {
  const miles: Record<RiskLevel, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    no_travel: 0,
  };
  let unknown = 0;
  let weighted = 0;
  let knownMiles = 0;
  let maxLevel: RiskLevel | null = null;
  for (const checkpoint of checkpoints) {
    const level = checkpoint.risk.level;
    if (level === null) {
      unknown += checkpoint.owned_mi;
      continue;
    }
    miles[level] += checkpoint.owned_mi;
    weighted += riskOrdinal(level) * checkpoint.owned_mi;
    knownMiles += checkpoint.owned_mi;
    if (maxLevel === null || riskOrdinal(level) > riskOrdinal(maxLevel)) maxLevel = level;
  }
  return {
    miles_by_level: {
      low: round(miles.low, 1),
      moderate: round(miles.moderate, 1),
      high: round(miles.high, 1),
      severe: round(miles.severe, 1),
      no_travel: round(miles.no_travel, 1),
    },
    unknown_mi: round(unknown, 1),
    avg_risk: knownMiles === 0 ? null : round(weighted / knownMiles, 3),
    max_level: maxLevel,
  };
}

/** A deterministic, well-formed plan id (`pln_` + 26 Crockford characters) derived from `key`. */
export function mockPlanId(key: string): string {
  let state = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    state = Math.imul(state ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  let id = "";
  for (let count = 0; count < 26; count += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    id += CROCKFORD.charAt(state >>> 27);
  }
  return `pln_${id}`;
}

/** The idempotency key of the contract: coords to 4 dp, departure to the minute, load, interval, scenario. */
export function idempotencyKey(request: PlanRequest): string {
  const { origin, destination } = request;
  return [
    origin.lat.toFixed(4),
    origin.lon.toFixed(4),
    destination.lat.toFixed(4),
    destination.lon.toFixed(4),
    request.departure_time.slice(0, 16),
    String(request.load_weight_lb),
    String(request.sampling_interval_mi),
    request.scenario ?? "null",
  ].join("|");
}

/**
 * The plan the mock backend returns for `request`.
 *
 * @throws {FixtureError} when the pair has no recorded route, the scenario is unknown or origin and
 * destination coincide.
 */
export function buildPlan(
  request: PlanRequest,
  options: { readonly createdAt?: string } = {},
): Plan {
  const world = buildWorld(request);
  const built = world.trip.routes.map((provider) => {
    const checkpoints = buildCheckpoints(world, provider);
    return { provider, checkpoints, stats: summarizeCheckpoints(checkpoints) };
  });
  const ranking = rankRoutes(
    built.map(({ provider, stats }) => ({
      routeId: provider.id,
      label: `Route ${provider.id}`,
      durationS: provider.durationS,
      distanceMi: provider.distanceMi,
      noTravelMi: stats.miles_by_level.no_travel,
      severeMi: stats.miles_by_level.severe,
      highMi: stats.miles_by_level.high,
      avgRisk: stats.avg_risk,
      unknownMi: stats.unknown_mi,
    })),
  );
  const routes: Route[] = ranking.order.map((routeId, position) => {
    const { provider, checkpoints, stats } = at(
      built,
      built.findIndex((candidate) => candidate.provider.id === routeId),
    );
    return {
      route_id: provider.id,
      label: `Route ${provider.id}`,
      summary: provider.summary,
      distance_mi: provider.distanceMi,
      duration_s: provider.durationS,
      departure_time: iso(world.departureMs),
      arrival_time: iso(world.departureMs + provider.durationS * 1000),
      geometry: { type: "LineString", coordinates: provider.coords },
      cumulative_mi: provider.cumulativeMi,
      cumulative_s: provider.cumulativeS,
      checkpoints,
      stats,
      rank: position + 1,
      recommended: position === 0,
    };
  });
  const createdMs =
    options.createdAt === undefined
      ? world.departureMs - 5 * 60_000
      : Date.parse(options.createdAt);
  const simulated = world.requestedScenario !== null;
  // In the order the backend writes them: the scenario notice, then each route that has a gap.
  const warnings = [
    ...(simulated ? [SCENARIO_NOTICE] : []),
    ...built.flatMap(({ provider, checkpoints, stats }) => {
      const unknown = checkpoints.filter((checkpoint) => checkpoint.risk.level === null).length;
      return unknown === 0
        ? []
        : [
            weatherGapWarning(
              `Route ${provider.id}`,
              unknown,
              checkpoints.length,
              stats.unknown_mi,
            ),
          ];
    }),
  ];
  return {
    plan_id: mockPlanId(idempotencyKey(request)),
    created_at: iso(createdMs),
    expires_at: iso(createdMs + 7 * 24 * HOUR_MS),
    request: {
      ...request,
      departure_time: iso(world.departureMs),
      scenario: world.requestedScenario,
    },
    sources: {
      routing: "valhalla",
      weather: simulated ? "scenario" : "open-meteo",
      weather_model: simulated ? "scenario" : "best_match",
      scenario: world.requestedScenario,
      attribution: [
        "© OpenStreetMap contributors",
        simulated ? SCENARIO_NOTICE : "Weather data by Open-Meteo.com (CC BY 4.0)",
      ],
    },
    routes,
    recommendation: {
      route_id: at(ranking.order, 0),
      status: ranking.status,
      decided_by: ranking.decidedBy,
      rationale: ranking.rationale,
      warnings: ranking.warnings,
    },
    warnings,
  };
}

/** Every `stepMi` miles along a route (plus its end), as lon/lat samples for the corridor test. */
function sampleRoute(route: DecodedRoute, stepMi: number): LonLat[] {
  const count = Math.ceil(route.distanceMi / stepMi);
  return Array.from({ length: count + 1 }, (_, step) =>
    positionAtDistance(route.coords, route.cumulativeMi, Math.min(step * stepMi, route.distanceMi)),
  );
}

/**
 * The 49-frame corridor heatmap of a plan: a regular grid whose spacing is a multiple of 0.1 degrees
 * (the smallest that keeps it within 200 cells) over the cells within 25 miles of any route.
 */
export function buildHeatmap(plan: Plan): Heatmap {
  const world = buildWorld(plan.request);
  const samples = world.trip.routes.flatMap((route) => sampleRoute(route, 4));
  const box = boundingBox(samples);
  const padLat = CORRIDOR_MI / MILES_PER_DEGREE;
  const padLon = padLat / Math.cos(((box.north + box.south) / 2) * RADIANS);
  const lat0 = Math.floor((box.south - padLat) * 10) / 10;
  const lon0 = Math.floor((box.west - padLon) * 10) / 10;
  for (let tenths = 2; ; tenths += 1) {
    const step = tenths / 10;
    const rows = Math.ceil((box.north + padLat - lat0) / step);
    const cols = Math.ceil((box.east + padLon - lon0) / step);
    const cells: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const lat = lat0 + (row + 0.5) * step;
        const lon = lon0 + (col + 0.5) * step;
        const cosLat = Math.cos(lat * RADIANS);
        const inCorridor = samples.some(([sampleLon, sampleLat]) => {
          const dx = (sampleLon - lon) * cosLat * MILES_PER_DEGREE;
          const dy = (sampleLat - lat) * MILES_PER_DEGREE;
          return dx * dx + dy * dy <= CORRIDOR_MI * CORRIDOR_MI;
        });
        if (inCorridor) cells.push(row * cols + col);
      }
    }
    if (cells.length > MAX_HEATMAP_CELLS) continue;
    const fields: Heatmap["fields"] = {
      risk: [],
      wind_mph: [],
      gust_mph: [],
      rain_in_hr: [],
      snow_in_hr: [],
    };
    for (let frame = 0; frame < HEATMAP_FRAME_COUNT; frame += 1) {
      for (const cell of cells) {
        const lat = lat0 + (Math.floor(cell / cols) + 0.5) * step;
        const lon = lon0 + ((cell % cols) + 0.5) * step;
        const values = world.field(lat, lon, frame);
        const missing = world.scenario === "partial-unknown" && cell % 7 === 3;
        const level = assessLevel(
          {
            valid_time: iso(world.startMs),
            wind_mph: values.wind_mph,
            gust_mph: values.gust_mph,
            rain_in_hr: values.rain_in_hr,
            snow_in_hr: values.snow_in_hr,
            temperature_f: values.temperature_f,
            weather_code: values.weather_code,
          },
          world.request.load_weight_lb,
        );
        fields.risk.push(missing ? -1 : heatmapRiskValue(level));
        fields.wind_mph.push(missing ? null : values.wind_mph);
        fields.gust_mph.push(missing ? null : values.gust_mph);
        fields.rain_in_hr.push(missing ? null : values.rain_in_hr);
        fields.snow_in_hr.push(missing ? null : values.snow_in_hr);
      }
    }
    return {
      plan_id: plan.plan_id,
      start_time: iso(world.startMs),
      frame_count: HEATMAP_FRAME_COUNT,
      step_minutes: HEATMAP_STEP_MINUTES,
      grid: { lat0: round(lat0, 1), lon0: round(lon0, 1), dlat: step, dlon: step, rows, cols },
      cells,
      fields,
      load_weight_lb: world.request.load_weight_lb,
      sources: plan.sources,
      generated_at: plan.created_at,
    };
  }
}
