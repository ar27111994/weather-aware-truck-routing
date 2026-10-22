import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

import type { Heatmap, Plan, PlanRequest } from "../../api/contract";
import type { ApiError } from "../../api/errors";
import { isAbortedError } from "../../api/errors";
import { useCreatePlan, useHeatmap, usePlan } from "../../api/queries";
import { useTripActions } from "../../state";
import type { RequestState } from "./PlanProgress";
import { buildTripSearch, parseTripSearch, type TripUrlState } from "./trip-url";
import { useIsClient } from "./use-is-client";

/** What the page has to say about an address that has no trip in it: the prerendered page's. */
const NO_PARAMS = new URLSearchParams();

/** What the address says and what the planner is doing about it. */
export interface PlannerSession {
  /** The inputs the address carries (used to start the form). */
  readonly inputs: TripUrlState;
  /** The query string the address has now: the form starts over whenever it changes. */
  readonly search: string;
  /** The plan on show: the one the address names, once it has arrived. */
  readonly plan: Plan | null;
  /** The request in flight, if any: `POST /plans`. */
  readonly planState: RequestState;
  /** The corridor forecast of the plan on show. */
  readonly heatmapState: RequestState;
  readonly heatmap: Heatmap | undefined;
  /** Why the last attempt failed: the plan request, or loading the plan the address names. */
  readonly error: ApiError | null;
  /** Makes a plan and puts it in the address (so the link restores it). */
  readonly submit: (request: PlanRequest) => void;
  /** Asks again for whatever failed. */
  readonly retry: () => void;
  /** Asks again for the corridor forecast after it failed. */
  readonly retryHeatmap: () => void;
}

/** The address of a plan: its inputs and its id. */
function addressOf(request: PlanRequest, planId: string): string {
  return buildTripSearch({
    origin: request.origin,
    destination: request.destination,
    depart: new Date(request.departure_time),
    load: request.load_weight_lb,
    interval: request.sampling_interval_mi,
    ...(request.scenario === null || request.scenario === undefined
      ? {}
      : { scenario: request.scenario }),
    plan: planId,
  });
}

/**
 * The planner's data and its address (R9). The address is the source of truth: `?plan=<id>` is the
 * plan on show, restored with a GET, so a shared link, a reload and the back button all land on the
 * same result. Making a plan pushes its address, so back and forward walk through the plans made. A
 * request made while another is in flight replaces it (the first is aborted), and an aborted
 * request never shows as an error.
 *
 * The prerendered page was drawn for an address with no trip in it, and the browser's first render
 * has to match it: a shared link would otherwise differ from the markup it hydrates, and React
 * would throw the page away (error 418) and clear `<html data-theme>`. So the address is read one
 * render later, once the browser has taken over (`useIsClient`), which the panel's key already
 * treats as a fresh start.
 */
export function usePlannerSession(): PlannerSession {
  const [params] = useSearchParams();
  const isClient = useIsClient();
  const navigate = useNavigate();
  const { resetForPlan } = useTripActions();
  const inputs = parseTripSearch(isClient ? params : NO_PARAMS);
  const search = buildTripSearch(inputs);

  const create = useCreatePlan();
  const stored = usePlan(inputs.plan);
  const plan = stored.data ?? null;
  const heatmap = useHeatmap(plan?.plan_id);

  // A failed request belongs to the address it was made at: another address starts clean.
  const { reset } = create;
  useEffect(() => {
    reset();
  }, [search, reset]);

  // A plan that arrives starts the map and the table on its recommended route, at departure.
  useEffect(() => {
    if (plan !== null) resetForPlan(plan);
  }, [plan, resetForPlan]);

  const failure =
    create.error !== null && !isAbortedError(create.error) ? create.error : stored.error;

  // Making a plan puts its address in the bar, so a link, a reload and the back button find it.
  const submit = (request: PlanRequest): void => {
    create.mutate(request, {
      onSuccess: (made) => {
        void navigate({ search: addressOf(request, made.plan_id) });
      },
    });
  };

  return {
    inputs,
    search,
    plan,
    planState:
      create.isPending || stored.isLoading ? "loading" : failure !== null ? "error" : "ready",
    heatmapState: heatmap.isError
      ? "error"
      : heatmap.isSuccess
        ? "ready"
        : plan === null
          ? "idle"
          : "loading",
    heatmap: heatmap.data,
    error: failure,
    submit,
    retry: () => {
      if (create.variables !== undefined && create.isError) {
        submit(create.variables);
      } else {
        void stored.refetch();
      }
    },
    retryHeatmap: () => {
      void heatmap.refetch();
    },
  };
}
