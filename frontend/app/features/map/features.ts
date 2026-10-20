/**
 * GeoJSON the route layers draw, built once per plan (DESIGN.md sections 9.3 to 9.5). Each builder
 * is a pure function of the plan, so a selection change, a theme switch or a slider tick never
 * rebuilds any of them.
 */
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

import type { Checkpoint, LonLat, Plan } from "../../api/contract";
import { riskInfo } from "../../design-system/foundation/risk";
import type { RiskKey } from "../../design-system/foundation/risk";
import { boundingBox } from "../../lib/geo";

/** Properties of a route line. */
export interface RouteProperties {
  readonly route_id: string;
  readonly rank: number;
  readonly recommended: boolean;
}

/** Properties of one risk-ribbon stretch: the checkpoint that owns it. */
export interface RibbonProperties {
  readonly route_id: string;
  readonly index: number;
  readonly level: RiskKey;
}

/** Properties of a checkpoint marker. */
export interface CheckpointProperties {
  readonly route_id: string;
  readonly index: number;
  readonly level: RiskKey;
  /** Drawing order: the level ordinal, Unknown (-1) underneath every scored level. */
  readonly ordinal: number;
  /** Local ETA label shown next to the marker at higher zoom. */
  readonly eta: string;
}

/** A checkpoint's owned span of route vertices (`coord_start..coord_end`, inclusive). */
export interface VertexSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Checkpoint feature ids are `routePosition * stride + checkpointIndex`. A plan holds at most 250
 * checkpoint locations (API-CONTRACT), far below the stride, so ids never collide.
 */
export const CHECKPOINT_ID_STRIDE = 10_000;

/**
 * The vertices of each stretch: a checkpoint's own `start..end` extended to the next checkpoint's
 * first vertex, so neighbouring stretches share a joint vertex and the ribbon has no hairline gaps
 * (DESIGN.md section 9.4). A stretch of a single vertex cannot be a line and is `null`.
 */
export function ribbonStretches(
  coords: readonly LonLat[],
  spans: readonly VertexSpan[],
): (LonLat[] | null)[] {
  return spans.map((span, position) => {
    const next = spans[position + 1];
    const end = next === undefined ? span.end : Math.max(span.end, next.start);
    const stretch = coords.slice(span.start, end + 1);
    return stretch.length >= 2 ? stretch : null;
  });
}

/** One line per route; the feature id is the route's position (feature-state `hover` keys on it). */
export function buildRouteCollection(plan: Plan): FeatureCollection<LineString, RouteProperties> {
  return {
    type: "FeatureCollection",
    features: plan.routes.map((route, position) => ({
      type: "Feature",
      id: position,
      geometry: route.geometry,
      properties: { route_id: route.route_id, rank: route.rank, recommended: route.recommended },
    })),
  };
}

/** One FeatureCollection holding every route's risk ribbon, coloured by its `level` property. */
export function buildRibbonCollection(plan: Plan): FeatureCollection<LineString, RibbonProperties> {
  const features = plan.routes.flatMap((route) => {
    const stretches = ribbonStretches(
      route.geometry.coordinates,
      route.checkpoints.map((checkpoint) => ({
        start: checkpoint.coord_start,
        end: checkpoint.coord_end,
      })),
    );
    return route.checkpoints.flatMap((checkpoint, position) => {
      const coordinates = stretches[position];
      if (!coordinates) return [];
      const feature: Feature<LineString, RibbonProperties> = {
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {
          route_id: route.route_id,
          index: checkpoint.index,
          level: riskInfo(checkpoint.risk.level).key,
        },
      };
      return [feature];
    });
  });
  return { type: "FeatureCollection", features };
}

/**
 * The feature id of checkpoint `index` of the route at `routePosition`.
 *
 * @throws {RangeError} when the index does not fit the stride.
 */
export function checkpointFeatureId(routePosition: number, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= CHECKPOINT_ID_STRIDE) {
    throw new RangeError(`Checkpoint index ${String(index)} does not fit the id stride`);
  }
  return routePosition * CHECKPOINT_ID_STRIDE + index;
}

/**
 * Markers for every checkpoint of every route (D-14) except each route's first and last, where the
 * origin and destination pins stand (DESIGN.md section 9.5).
 *
 * @param etaLabel - Local ETA text of a checkpoint (built by the caller in the user's locale).
 */
export function buildCheckpointCollection(
  plan: Plan,
  etaLabel: (checkpoint: Checkpoint) => string,
): FeatureCollection<Point, CheckpointProperties> {
  const features = plan.routes.flatMap((route, routePosition) =>
    route.checkpoints.slice(1, -1).map((checkpoint): Feature<Point, CheckpointProperties> => {
      const info = riskInfo(checkpoint.risk.level);
      return {
        type: "Feature",
        id: checkpointFeatureId(routePosition, checkpoint.index),
        geometry: { type: "Point", coordinates: [checkpoint.lon, checkpoint.lat] },
        properties: {
          route_id: route.route_id,
          index: checkpoint.index,
          level: info.key,
          ordinal: info.ordinal,
          eta: etaLabel(checkpoint),
        },
      };
    }),
  );
  return { type: "FeatureCollection", features };
}

/** The extent of all routes as `[west, south, east, north]` (what `fitBounds` takes). */
export function routeBounds(plan: Plan): [number, number, number, number] {
  const box = boundingBox(plan.routes.flatMap((route) => route.geometry.coordinates));
  return [box.west, box.south, box.east, box.north];
}
