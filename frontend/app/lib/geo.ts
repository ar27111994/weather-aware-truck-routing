import type { LonLat } from "../api/contract";
import { at } from "./checked";

/** Mean Earth radius in miles (DOMAIN-CONTRACT §6). */
const EARTH_RADIUS_MI = 3958.7613;
const MILES_PER_DEGREE = (EARTH_RADIUS_MI * Math.PI) / 180;
const RADIANS = Math.PI / 180;
/** A polyline value spans at most seven 5-bit chunks (a 32-bit integer). */
const MAX_VALUE_SHIFT = 35;

/** Axis-aligned extent in degrees. No antimeridian handling: routes are continental. */
export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

function readValue(
  encoded: string,
  start: number,
): { readonly value: number; readonly next: number } {
  let result = 0;
  let shift = 0;
  let index = start;
  for (;;) {
    if (index >= encoded.length) throw new RangeError("Truncated polyline");
    const chunk = encoded.charCodeAt(index) - 63;
    if (chunk < 0 || chunk > 63) throw new RangeError("Invalid polyline character");
    if (shift >= MAX_VALUE_SHIFT) throw new RangeError("Polyline value too long");
    index += 1;
    result += (chunk % 32) * 2 ** shift;
    shift += 5;
    if (chunk < 32) break;
  }
  return { value: result % 2 === 1 ? -(result + 1) / 2 : result / 2, next: index };
}

function writeValue(value: number): string {
  let remaining = value < 0 ? -value * 2 - 1 : value * 2;
  let text = "";
  while (remaining >= 32) {
    text += String.fromCharCode(32 + (remaining % 32) + 63);
    remaining = Math.floor(remaining / 32);
  }
  return text + String.fromCharCode(remaining + 63);
}

/**
 * Decodes an encoded polyline (Valhalla: precision 6, OSRM/Google: precision 5). The encoding
 * stores latitude then longitude as deltas; the result is `[lon, lat]` pairs.
 *
 * @throws {RangeError} on a truncated value, a character outside the alphabet or an overlong value.
 */
export function decodePolyline(encoded: string, precision: 5 | 6): LonLat[] {
  const factor = 10 ** precision;
  const coords: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    const latStep = readValue(encoded, index);
    const lonStep = readValue(encoded, latStep.next);
    lat += latStep.value;
    lon += lonStep.value;
    coords.push([lon / factor, lat / factor]);
    index = lonStep.next;
  }
  return coords;
}

/** Inverse of {@link decodePolyline}; coordinates are rounded to `precision` decimals. */
export function encodePolyline(coords: readonly LonLat[], precision: 5 | 6): string {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLon = 0;
  let text = "";
  for (const [lon, lat] of coords) {
    const scaledLat = Math.round(lat * factor);
    const scaledLon = Math.round(lon * factor);
    text += writeValue(scaledLat - previousLat) + writeValue(scaledLon - previousLon);
    previousLat = scaledLat;
    previousLon = scaledLon;
  }
  return text;
}

/** Great-circle distance in miles (mean Earth radius 3958.7613 mi). */
export function haversineMiles(a: LonLat, b: LonLat): number {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const dLat = (latB - latA) * RADIANS;
  const dLon = (lonB - lonA) * RADIANS;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * RADIANS) * Math.cos(latB * RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Cumulative miles per vertex, starting at 0. With `totalMiles` the values are linearly rescaled so
 * the last equals the provider's reported length exactly (a path with no length stays all zeros).
 */
export function cumulativeMiles(coords: readonly LonLat[], totalMiles?: number): number[] {
  const sums: number[] = [];
  let sum = 0;
  let previous: LonLat | undefined;
  for (const coord of coords) {
    if (previous) sum += haversineMiles(previous, coord);
    sums.push(sum);
    previous = coord;
  }
  if (totalMiles === undefined) return sums;
  const scale = sum === 0 ? 0 : totalMiles / sum;
  return sums.map((value, index) =>
    index === sums.length - 1 && sum > 0 ? totalMiles : Math.min(value * scale, totalMiles),
  );
}

/** The extent of `coords`. @throws {RangeError} when `coords` is empty. */
export function boundingBox(coords: readonly LonLat[]): BoundingBox {
  const [first, ...rest] = coords;
  if (!first) throw new RangeError("Cannot compute the bounding box of an empty path");
  let [west, south] = first;
  let [east, north] = first;
  for (const [lon, lat] of rest) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

/**
 * The vertices `start..end` inclusive (the API's `coord_start..coord_end`), as a new array.
 *
 * @throws {RangeError} unless both are integers with `0 <= start <= end < coords.length`.
 */
export function sliceGeometry(coords: readonly LonLat[], start: number, end: number): LonLat[] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    end >= coords.length
  ) {
    throw new RangeError(
      `Invalid vertex range ${String(start)}..${String(end)} for ${String(coords.length)} vertices`,
    );
  }
  return coords.slice(start, end + 1);
}

/** Linear interpolation of the position at `target` along a monotone `cumulative` array. */
function interpolate(
  coords: readonly LonLat[],
  cumulative: readonly number[],
  target: number,
): LonLat {
  if (Number.isNaN(target)) throw new RangeError("The interpolation target must not be NaN");
  if (coords.length !== cumulative.length) {
    throw new RangeError("coords and cumulative values must have the same length");
  }
  const clamped = Math.min(
    Math.max(target, at(cumulative, 0)),
    at(cumulative, cumulative.length - 1),
  );
  const upper = Math.max(
    1,
    cumulative.findIndex((value) => value >= clamped),
  );
  const startValue = at(cumulative, upper - 1);
  const span = at(cumulative, upper) - startValue;
  const fraction = span === 0 ? 0 : (clamped - startValue) / span;
  const [startLon, startLat] = at(coords, upper - 1);
  const [endLon, endLat] = at(coords, upper);
  return [startLon + (endLon - startLon) * fraction, startLat + (endLat - startLat) * fraction];
}

/**
 * The position `distanceMi` along the route, interpolated between the bracketing vertices
 * (clamped to the ends). `cumulativeMi` aligns 1:1 with `coords`.
 *
 * @throws {RangeError} for mismatched lengths, fewer than two vertices or a NaN distance.
 */
export function positionAtDistance(
  coords: readonly LonLat[],
  cumulativeMi: readonly number[],
  distanceMi: number,
): LonLat {
  return interpolate(coords, cumulativeMi, distanceMi);
}

/**
 * The position `elapsedS` seconds after departure, or `null` before departure / after arrival (the
 * truck marker is hidden). `cumulativeS` aligns 1:1 with `coords`.
 *
 * @throws {RangeError} for mismatched lengths or fewer than two vertices.
 */
export function positionAtElapsed(
  coords: readonly LonLat[],
  cumulativeS: readonly number[],
  elapsedS: number,
): LonLat | null {
  if (elapsedS < 0 || elapsedS > at(cumulativeS, cumulativeS.length - 1)) return null;
  return interpolate(coords, cumulativeS, elapsedS);
}

/** Distance in projected miles from point `p` to the segment `a`-`b`. */
function distanceToSegment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker simplification (iterative, safe for 25,000+ vertices). Deviation is measured in a
 * local equirectangular projection in miles; the first and last vertex are always kept and the
 * result is an ordered subsequence of the input.
 *
 * @throws {RangeError} when `toleranceMiles` is negative or NaN.
 */
export function simplifyPath(coords: readonly LonLat[], toleranceMiles: number): LonLat[] {
  if (!(toleranceMiles >= 0)) throw new RangeError("toleranceMiles must be a non-negative number");
  if (coords.length <= 2) return [...coords];
  const meanLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length;
  const xScale = Math.cos(meanLat * RADIANS) * MILES_PER_DEGREE;
  const projected = coords.map(([lon, lat]): [number, number] => [
    lon * xScale,
    lat * MILES_PER_DEGREE,
  ]);
  const keep = new Set<number>([0, coords.length - 1]);
  const stack: [number, number][] = [[0, coords.length - 1]];
  for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
    const [first, last] = range;
    const a = at(projected, first);
    const b = at(projected, last);
    let farthest = -1;
    let farthestDistance = toleranceMiles;
    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(at(projected, index), a, b);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return coords.filter((_, index) => keep.has(index));
}
