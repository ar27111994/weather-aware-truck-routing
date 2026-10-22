import { useState } from "react";

import type { PlanLocation, PlanRequest, SamplingIntervalMi } from "../../api/contract";
import { DEFAULT_SAMPLING_INTERVAL_MI } from "../../lib/risk";
import { initialDeparture, instantOf, type Clock, type DepartureDraft } from "./departure";
import { TRIP_FIELDS, validateTrip, type TripErrors, type TripField } from "./trip-schema";
import type { TripUrlState } from "./trip-url";

/** A place field's state: what the input shows and the place picked from the list. */
interface PlaceState {
  readonly text: string;
  readonly place: PlanLocation | null;
}

function placeState(place: PlanLocation | undefined): PlaceState {
  return { text: place?.label ?? "", place: place ?? null };
}

/** A place counts as chosen only while the input still shows exactly its label. */
function chosen({ text, place }: PlaceState): PlanLocation | null {
  return place !== null && place.label === text ? place : null;
}

function without(errors: TripErrors, ...fields: readonly TripField[]): TripErrors {
  const rest: TripErrors = {};
  for (const field of TRIP_FIELDS) {
    const message = errors[field];
    if (message !== undefined && !fields.includes(field)) rest[field] = message;
  }
  return rest;
}

/** Everything the trip form holds, with the one-field edits the inputs call. */
export interface PlannerFormState {
  readonly origin: PlaceState;
  readonly destination: PlaceState;
  readonly departure: DepartureDraft;
  /** Pounds; `NaN` while the field is empty. */
  readonly load: number;
  readonly interval: SamplingIntervalMi;
  /** A scenario id, or `null` for the live forecast. */
  readonly scenario: string | null;
  /** The errors to show next to the fields: from the last submit, or from the server. */
  readonly errors: TripErrors;
  readonly setOriginText: (text: string) => void;
  readonly pickOrigin: (place: PlanLocation | null) => void;
  readonly setDestinationText: (text: string) => void;
  readonly pickDestination: (place: PlanLocation | null) => void;
  readonly swapPlaces: () => void;
  readonly setDeparture: (departure: DepartureDraft) => void;
  readonly setLoad: (pounds: number) => void;
  readonly setInterval: (interval: SamplingIntervalMi) => void;
  readonly setScenario: (scenario: string | null) => void;
  /** Shows errors next to the fields (the server's, mapped); an edit of a field clears its error. */
  readonly showErrors: (errors: TripErrors) => void;
  /**
   * Checks the form. On a problem the errors show next to the fields and the result is `null`; on a
   * valid trip it is the `POST /plans` body.
   */
  readonly submit: () => PlanRequest | null;
}

/**
 * The trip form's state (R1). Starts from a link's inputs where it has them, else from the defaults
 * (departure now, 25 mile checkpoints, live weather). Editing a field clears that field's error, so
 * a message never outlives the value it was about.
 *
 * @param defaults - The inputs the address carried.
 * @param clock - The visitor's clock; `null` on the prerendered page, where the departure is empty
 *   until the clock arrives.
 */
export function usePlannerForm(defaults: TripUrlState, clock: Clock | null): PlannerFormState {
  const [origin, setOrigin] = useState(() => placeState(defaults.origin));
  const [destination, setDestination] = useState(() => placeState(defaults.destination));
  const [departure, setDepartureState] = useState(() => initialDeparture(defaults.depart, clock));
  // The prerendered page has no clock, and the browser takes the page over in place: nothing is thrown
  // away and rebuilt, so what the visitor did meanwhile stays (D-46). The departure therefore starts
  // empty and is filled in, once, when the clock arrives, unless the visitor has already set it.
  const [seeded, setSeeded] = useState(clock !== null);
  if (clock !== null && !seeded) {
    setSeeded(true);
    setDepartureState((current) =>
      current.date === null && current.time === null
        ? initialDeparture(defaults.depart, clock)
        : current,
    );
  }
  const [load, setLoadState] = useState(defaults.load ?? Number.NaN);
  const [interval, setIntervalState] = useState<SamplingIntervalMi>(
    defaults.interval ?? DEFAULT_SAMPLING_INTERVAL_MI,
  );
  const [scenario, setScenarioState] = useState<string | null>(defaults.scenario ?? null);
  const [errors, setErrors] = useState<TripErrors>({});

  const edit = (...fields: readonly TripField[]): void => {
    setErrors((current) => without(current, ...fields));
  };

  return {
    origin,
    destination,
    departure,
    load,
    interval,
    scenario,
    errors,
    setOriginText: (text) => {
      setOrigin((current) => ({ ...current, text }));
      edit("origin");
    },
    pickOrigin: (place) => {
      setOrigin((current) => ({ text: place?.label ?? current.text, place }));
      edit("origin");
    },
    setDestinationText: (text) => {
      setDestination((current) => ({ ...current, text }));
      edit("destination");
    },
    pickDestination: (place) => {
      setDestination((current) => ({ text: place?.label ?? current.text, place }));
      edit("destination");
    },
    swapPlaces: () => {
      setOrigin(destination);
      setDestination(origin);
      edit("origin", "destination");
    },
    setDeparture: (next) => {
      setDepartureState(next);
      edit("departure");
    },
    setLoad: (pounds) => {
      setLoadState(pounds);
      edit("load");
    },
    setInterval: (next) => {
      setIntervalState(next);
      edit("interval");
    },
    setScenario: setScenarioState,
    showErrors: setErrors,
    submit: () => {
      const validation = validateTrip(
        {
          origin: chosen(origin),
          destination: chosen(destination),
          departure: instantOf(departure, clock?.timeZone ?? "UTC"),
          load,
          interval,
          scenario,
        },
        clock?.now() ?? new Date(),
      );
      if (!validation.ok) {
        setErrors(validation.errors);
        return null;
      }
      setErrors({});
      return validation.request;
    },
  };
}
