/**
 * Truck markers at the slider's time (R16): each route's truck sits where its schedule puts it,
 * interpolated along the geometry by `cumulative_s`; hidden before departure and after arrival.
 */
import type { LonLat, Plan } from "../../api/contract";
import { positionAtElapsed } from "../../lib/geo";

const SECONDS_PER_HOUR = 3600;

/** Where one route's truck is at a frame, or `null` when it is not on the road. */
export interface TruckPosition {
  readonly routeId: string;
  readonly position: LonLat | null;
}

/**
 * Seconds since `departureMs` at heatmap `frame` (frame 0 is `startMs`, the departure floored to the
 * hour, so frame 0 can be minutes before the truck leaves).
 */
export function frameElapsedSeconds(startMs: number, departureMs: number, frame: number): number {
  return (startMs - departureMs) / 1000 + frame * SECONDS_PER_HOUR;
}

/** Every route's truck position at `frame` of a timeline that starts at `startMs`. */
export function truckPositions(plan: Plan, startMs: number, frame: number): TruckPosition[] {
  return plan.routes.map((route) => ({
    routeId: route.route_id,
    position: positionAtElapsed(
      route.geometry.coordinates,
      route.cumulative_s,
      frameElapsedSeconds(startMs, Date.parse(route.departure_time), frame),
    ),
  }));
}
