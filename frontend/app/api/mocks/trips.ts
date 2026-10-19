/**
 * The recorded trips the mock API can answer: REAL Valhalla route geometries (committed as
 * simplified polylines in `data/trips.json`, produced by `scripts/extract-route-fixtures.js` from the
 * T1 research samples), plus the geocode catalog the autocomplete mock searches.
 */
import { z } from "zod";

import { at } from "../../lib/checked";
import { cumulativeMiles, decodePolyline, haversineMiles } from "../../lib/geo";
import { planLocationSchema, type GeocodeResult, type LonLat, type PlanLocation } from "../contract";
import tripsJson from "./data/trips.json";

const routeDataSchema = z.object({
  id: z.string(),
  summary: z.string(),
  distance_mi: z.number().positive(),
  duration_s: z.number().positive(),
  polyline5: z.string().min(1),
  vertices: z.number().int().positive(),
  anchors: z.array(z.tuple([z.number(), z.number()])).min(2),
});

const tripsDataSchema = z.object({
  provenance: z.object({
    generator: z.string(),
    provider: z.string(),
    transform: z.string(),
    samples: z.array(z.object({ file: z.string(), sha256: z.string().length(64) })),
  }),
  trips: z
    .array(
      z.object({
        id: z.string(),
        origin: planLocationSchema,
        destination: planLocationSchema,
        routes: z.array(routeDataSchema).min(1).max(3),
      }),
    )
    .min(1),
});

/** The committed route data, validated at load time. */
export const TRIPS_DATA = tripsDataSchema.parse(tripsJson);

/** One provider route with its per-vertex cumulative arrays. */
export interface DecodedRoute {
  readonly id: string;
  readonly summary: string;
  readonly distanceMi: number;
  readonly durationS: number;
  readonly coords: LonLat[];
  readonly cumulativeMi: number[];
  readonly cumulativeS: number[];
}

/** A recorded origin/destination pair and its provider routes (in provider order). */
export interface Trip {
  readonly id: string;
  readonly origin: PlanLocation;
  readonly destination: PlanLocation;
  readonly routes: DecodedRoute[];
}

/** Linear interpolation of `ys` at `x` over ascending `xs` (clamped to the ends). */
export function interpolateLinear(xs: readonly number[], ys: readonly number[], x: number): number {
  const clamped = Math.min(Math.max(x, at(xs, 0)), at(xs, xs.length - 1));
  const upper = Math.max(1, xs.findIndex((value) => value >= clamped));
  const startX = at(xs, upper - 1);
  const span = at(xs, upper) - startX;
  const fraction = span === 0 ? 0 : (clamped - startX) / span;
  return at(ys, upper - 1) + (at(ys, upper) - at(ys, upper - 1)) * fraction;
}

const round = (value: number, decimals: number): number => Math.round(value * 10 ** decimals) / 10 ** decimals;

function decodeRoute(data: z.infer<typeof routeDataSchema>): DecodedRoute {
  const coords = decodePolyline(data.polyline5, 5);
  const cumulativeMi = cumulativeMiles(coords, data.distance_mi).map((value) => round(value, 3));
  const lastAnchor = at(data.anchors, data.anchors.length - 1);
  const anchorMi = data.anchors.map(([miles]) => (miles / lastAnchor[0]) * data.distance_mi);
  const anchorS = data.anchors.map(([, seconds]) => (seconds / lastAnchor[1]) * data.duration_s);
  return {
    id: data.id,
    summary: data.summary,
    distanceMi: data.distance_mi,
    durationS: data.duration_s,
    coords,
    cumulativeMi,
    cumulativeS: cumulativeMi.map((miles) => Math.round(interpolateLinear(anchorMi, anchorS, miles))),
  };
}

/** The recorded trips, decoded once. */
export const TRIPS: readonly Trip[] = TRIPS_DATA.trips.map((trip) => ({
  id: trip.id,
  origin: trip.origin,
  destination: trip.destination,
  routes: trip.routes.map(decodeRoute),
}));

/** How close (miles) a requested endpoint must be to a recorded one to count as the same place. */
const ENDPOINT_TOLERANCE_MI = 30;

/** The recorded trip whose endpoints match the request, or `undefined` when none does. */
export function findTrip(origin: PlanLocation, destination: PlanLocation, trips: readonly Trip[] = TRIPS): Trip | undefined {
  return trips.find(
    (trip) =>
      haversineMiles([origin.lon, origin.lat], [trip.origin.lon, trip.origin.lat]) <= ENDPOINT_TOLERANCE_MI &&
      haversineMiles([destination.lon, destination.lat], [trip.destination.lon, trip.destination.lat]) <= ENDPOINT_TOLERANCE_MI,
  );
}

/** Cities the geocode mock knows (ids other than Denver's are fixture ids, not real OSM ids). */
export const GEOCODE_CATALOG: readonly GeocodeResult[] = [
  ["osm:R1411339", "Denver", "Colorado", 39.7392, -104.9903],
  ["osm:R-fixture-slc", "Salt Lake City", "Utah", 40.7608, -111.891],
  ["osm:R-fixture-chi", "Chicago", "Illinois", 41.8781, -87.6298],
  ["osm:R-fixture-ewr", "Newark", "New Jersey", 40.7357, -74.1724],
  ["osm:R-fixture-jc", "Jersey City", "New Jersey", 40.7178, -74.0431],
  ["osm:R-fixture-dal", "Dallas", "Texas", 32.7767, -96.797],
  ["osm:R-fixture-atl", "Atlanta", "Georgia", 33.749, -84.388],
  ["osm:R-fixture-lax", "Los Angeles", "California", 34.0522, -118.2437],
  ["osm:R-fixture-phx", "Phoenix", "Arizona", 33.4484, -112.074],
  ["osm:R-fixture-sea", "Seattle", "Washington", 47.6062, -122.3321],
].map(([id, name, region, lat, lon]) => ({
  id: String(id),
  label: `${String(name)}, ${String(region)}, United States`,
  name: String(name),
  region: String(region),
  country: "United States",
  country_code: "US",
  kind: "city",
  lat: Number(lat),
  lon: Number(lon),
}));

/** Catalog entries whose name or label contains `query` (case-insensitive), prefix matches first. */
export function searchGeocode(query: string, limit: number): GeocodeResult[] {
  const needle = query.trim().toLowerCase();
  const matches = GEOCODE_CATALOG.filter((entry) => entry.label.toLowerCase().includes(needle));
  const prefix = matches.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  const rest = matches.filter((entry) => !entry.name.toLowerCase().startsWith(needle));
  return [...prefix, ...rest].slice(0, limit);
}
