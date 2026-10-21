import type { ApiError } from "../../api/errors";
import { t, type StringKey } from "../../design-system/foundation/strings";
import type { TripErrors, TripField } from "./trip-schema";

/** How a failed plan request shows: next to fields, or as the error panel. */
export interface PlanFailure {
  /** Field errors to show next to the inputs; empty when the failure is not about a field. */
  readonly fieldErrors: TripErrors;
  /** Whether the error panel (title, body, retry) should show. True when no field is to blame. */
  readonly showsPanel: boolean;
}

/** The request body key a 422's `loc` names, mapped to the form field it comes from. */
const FIELD_OF_BODY_KEY: ReadonlyMap<string, TripField> = new Map<string, TripField>([
  ["origin", "origin"],
  ["destination", "destination"],
  ["departure_time", "departure"],
  ["load_weight_lb", "load"],
  ["sampling_interval_mi", "interval"],
]);

/** What a field says when the server rejects it: the form's own wording, not the server's. */
const FIELD_MESSAGE: Readonly<Record<TripField, StringKey>> = {
  origin: "form.origin.error.required",
  destination: "form.destination.error.required",
  departure: "form.departure.error.range",
  load: "form.load.error.range",
  interval: "form.interval.error",
};

/** Domain codes that blame one field, with the message the field gets. */
const FIELD_OF_CODE: ReadonlyMap<string, readonly [TripField, StringKey]> = new Map<
  string,
  readonly [TripField, StringKey]
>([
  ["same_origin_destination", ["destination", "form.destination.error.tooClose"]],
  ["departure_out_of_range", ["departure", "form.departure.error.range"]],
]);

/**
 * Maps a failed `POST /plans` onto the form (R1: the server rejects the same invalid input with
 * a 422, and the form answers in the same words as its own checks). A 422 whose domain code names
 * a field, or whose `errors[].loc` points into the body, marks those fields; anything else (no
 * route, a trip too long, an upstream fault, a rate limit) is not a field's fault and gets the
 * error panel.
 */
export function planFailure(error: ApiError): PlanFailure {
  const fieldErrors: TripErrors = {};
  if (error.status === 422) {
    const byCode = FIELD_OF_CODE.get(error.code);
    if (byCode !== undefined) {
      fieldErrors[byCode[0]] = t(byCode[1]);
    }
    for (const problem of error.errors) {
      const [scope, key] = problem.loc;
      const field =
        scope === "body" && typeof key === "string" ? FIELD_OF_BODY_KEY.get(key) : undefined;
      if (field !== undefined) {
        fieldErrors[field] ??= t(FIELD_MESSAGE[field]);
      }
    }
  }
  return { fieldErrors, showsPanel: Object.keys(fieldErrors).length === 0 };
}
