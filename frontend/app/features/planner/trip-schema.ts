import { z } from "zod";

import {
  SAMPLING_INTERVALS_MI,
  planLocationSchema,
  type PlanLocation,
  type PlanRequest,
  type RiskRules,
  type SamplingIntervalMi,
} from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { haversineMiles } from "../../lib/geo";
import { RISK_RULES } from "../../lib/risk";

/** The API accepts a departure up to this many minutes in the past (clock skew, a slow tap). */
export const DEPARTURE_GRACE_MINUTES = 15;
/** ... and up to this many hours ahead (the 0 to 48 h forecast starts at departure). */
export const DEPARTURE_WINDOW_HOURS = 120;
/** Origin and destination must be at least this far apart (API-CONTRACT, `POST /plans`). */
export const MIN_TRIP_MILES = 1;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The five inputs of the trip form that can carry an error. */
export type TripField = "origin" | "destination" | "departure" | "load" | "interval";

/** What the form holds: places chosen from the list, an instant, a load, an interval. */
export interface TripDraft {
  /** The place picked from the suggestions; `null` until one is chosen. */
  readonly origin: PlanLocation | null;
  readonly destination: PlanLocation | null;
  /** The chosen departure; `null` while the date or the time is empty. */
  readonly departure: Date | null;
  /** Pounds; `NaN` while the field is empty (what React Aria's number field reports). */
  readonly load: number;
  readonly interval: SamplingIntervalMi;
  /** A scenario id, or `null` for the live forecast. */
  readonly scenario: string | null;
}

/** Field errors in the form's own words (microcopy), one per field. */
export type TripErrors = Partial<Record<TripField, string>>;

/** A request the API will take, or the errors to show next to the fields. */
export type TripValidation =
  | { readonly ok: true; readonly request: PlanRequest }
  | { readonly ok: false; readonly errors: TripErrors };

/**
 * The window the API accepts a departure in, measured from `now`: 15 minutes back to 120 hours
 * ahead (API-CONTRACT, `POST /plans`).
 */
export function departureBounds(now: Date): { readonly earliest: Date; readonly latest: Date } {
  return {
    earliest: new Date(now.getTime() - DEPARTURE_GRACE_MINUTES * MINUTE_MS),
    latest: new Date(now.getTime() + DEPARTURE_WINDOW_HOURS * HOUR_MS),
  };
}

/** A place that is complete and inside the API's limits; anything else asks for a list pick. */
function place(message: string): z.ZodCustom<PlanLocation, PlanLocation> {
  return z.custom<PlanLocation>((value) => planLocationSchema.safeParse(value).success, {
    error: message,
  });
}

function tripSchema(now: Date, rules: RiskRules) {
  const { earliest, latest } = departureBounds(now);
  const range = t("form.departure.error.range");
  const loadRange = t("form.load.error.range");
  return z.object({
    origin: place(t("form.origin.error.required")),
    destination: place(t("form.destination.error.required")),
    departure: z
      .date({ error: t("form.departure.error.required") })
      .min(earliest, { error: range })
      .max(latest, { error: range }),
    load: z
      .number({ error: t("form.load.error.required") })
      .int({ error: t("form.load.error.integer") })
      .min(rules.load_limits_lb.min, { error: loadRange })
      .max(rules.load_limits_lb.max, { error: loadRange }),
    interval: z.literal(SAMPLING_INTERVALS_MI, { error: t("form.interval.error") }),
    scenario: z.string().nullable(),
  });
}

/** The minute a departure falls in: the form edits minutes and the API keys plans by the minute. */
function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * Checks the form against the same rules the server enforces (so an invalid trip never reaches the
 * API) and builds the `POST /plans` body. The server stays the authority: its 422 answers are
 * mapped back onto the same fields (`server-errors.ts`).
 *
 * @param draft - What the form holds.
 * @param now - The current time, for the departure window; a parameter so a test pins it.
 * @param rules - The risk rules, for the load range; defaults to the bundled file.
 */
export function validateTrip(
  draft: TripDraft,
  now: Date,
  rules: RiskRules = RISK_RULES,
): TripValidation {
  const parsed = tripSchema(now, rules).safeParse({
    ...draft,
    departure: draft.departure === null ? null : floorToMinute(draft.departure),
  });
  if (!parsed.success) {
    const errors: TripErrors = {};
    for (const issue of parsed.error.issues) {
      // Every issue comes from one key of the object above, so its first path segment is a field.
      const field = issue.path[0] as TripField;
      errors[field] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const trip = parsed.data;
  const apart = haversineMiles(
    [trip.origin.lon, trip.origin.lat],
    [trip.destination.lon, trip.destination.lat],
  );
  if (apart < MIN_TRIP_MILES) {
    return { ok: false, errors: { destination: t("form.destination.error.tooClose") } };
  }
  return {
    ok: true,
    request: {
      origin: trip.origin,
      destination: trip.destination,
      departure_time: trip.departure.toISOString().replace(".000Z", "Z"),
      load_weight_lb: trip.load,
      sampling_interval_mi: trip.interval,
      scenario: trip.scenario,
    },
  };
}
