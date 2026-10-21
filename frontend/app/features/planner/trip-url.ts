import {
  SAMPLING_INTERVALS_MI,
  isPlanId,
  planLocationSchema,
  type PlanLocation,
  type SamplingIntervalMi,
} from "../../api/contract";

/**
 * What the address bar says about a trip (R9). Every field is optional: a link may carry only a
 * plan id, only the inputs, or both. A value that does not parse is left out, never guessed.
 */
export interface TripUrlState {
  readonly origin?: PlanLocation;
  readonly destination?: PlanLocation;
  /** The departure instant, to the minute. */
  readonly depart?: Date;
  readonly load?: number;
  readonly interval?: SamplingIntervalMi;
  /** A scenario id; absent means the live forecast. */
  readonly scenario?: string;
  readonly plan?: string;
}

const MINUTE_MS = 60_000;
const COORDINATE = /^-?\d{1,3}(?:\.\d{1,6})?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;
const WHOLE_NUMBER = /^\d{1,6}$/;
const SCENARIO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `Salt Lake City, Utah@40.7608,-111.891`: the label, then `@`, then latitude and longitude. */
function parsePlace(value: string | null): PlanLocation | undefined {
  if (value === null) return undefined;
  const at = value.lastIndexOf("@");
  const [lat = "", lon = "", ...rest] = value.slice(at + 1).split(",");
  if (at < 1 || rest.length > 0 || !COORDINATE.test(lat) || !COORDINATE.test(lon)) {
    return undefined;
  }
  const place = planLocationSchema.safeParse({
    lat: Number(lat),
    lon: Number(lon),
    label: value.slice(0, at),
  });
  return place.success ? place.data : undefined;
}

function parseInstant(value: string | null): Date | undefined {
  if (value === null || !INSTANT.test(value)) return undefined;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : new Date(Math.floor(instant / MINUTE_MS) * MINUTE_MS);
}

function parseInterval(value: string | null): SamplingIntervalMi | undefined {
  return SAMPLING_INTERVALS_MI.find((interval) => String(interval) === value);
}

/**
 * Reads a trip from a query string. Unknown parameters are ignored and malformed ones dropped, so
 * a hand-edited or truncated link degrades to a partly filled form instead of an error.
 *
 * @param search - A query string (with or without the leading `?`) or parsed parameters.
 */
export function parseTripSearch(search: string | URLSearchParams): TripUrlState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const origin = parsePlace(params.get("origin"));
  const destination = parsePlace(params.get("destination"));
  const depart = parseInstant(params.get("depart"));
  const loadText = params.get("load");
  const interval = parseInterval(params.get("interval"));
  const scenario = params.get("scenario");
  const plan = params.get("plan");
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(destination === undefined ? {} : { destination }),
    ...(depart === undefined ? {} : { depart }),
    ...(loadText !== null && WHOLE_NUMBER.test(loadText) ? { load: Number(loadText) } : {}),
    ...(interval === undefined ? {} : { interval }),
    ...(scenario !== null && SCENARIO_ID.test(scenario) ? { scenario } : {}),
    ...(isPlanId(plan) ? { plan } : {}),
  };
}

/** Six decimals is about 10 cm: enough for a place, and short enough for a link. */
function coordinate(degrees: number): string {
  return String(Number(degrees.toFixed(6)) + 0);
}

function serializePlace(place: PlanLocation): string {
  return `${place.label}@${coordinate(place.lat)},${coordinate(place.lon)}`;
}

/**
 * The query string of a trip: `?origin=…&destination=…&depart=…&load=…&interval=…&scenario=…&plan=…`,
 * or an empty string when there is nothing to say. Parameters come in this fixed order, so the same
 * trip always gives the same address.
 */
export function buildTripSearch(state: TripUrlState): string {
  const params = new URLSearchParams();
  if (state.origin !== undefined) params.set("origin", serializePlace(state.origin));
  if (state.destination !== undefined) params.set("destination", serializePlace(state.destination));
  if (state.depart !== undefined) {
    const minute = new Date(Math.floor(state.depart.getTime() / MINUTE_MS) * MINUTE_MS);
    params.set("depart", minute.toISOString().replace(".000Z", "Z"));
  }
  if (state.load !== undefined) params.set("load", String(state.load));
  if (state.interval !== undefined) params.set("interval", String(state.interval));
  if (state.scenario !== undefined) params.set("scenario", state.scenario);
  if (state.plan !== undefined) params.set("plan", state.plan);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
