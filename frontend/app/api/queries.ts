import {
  QueryClient,
  keepPreviousData,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { createApiClient, type ApiClient } from "./client";
import {
  isPlanId,
  type GeocodeResponse,
  type Heatmap,
  type Plan,
  type PlanRequest,
  type RiskRules,
  type Scenario,
} from "./contract";
import type { ApiError } from "./errors";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-endpoint freshness, from the contract's `Cache-Control` values: geocode `max-age=86400`,
 * plans and heatmaps `max-age=300`, rules a long cache, scenarios a static list.
 */
export const CACHE_POLICY = {
  geocode: { staleTime: DAY, gcTime: HOUR },
  plan: { staleTime: 5 * MINUTE, gcTime: 30 * MINUTE },
  heatmap: { staleTime: 5 * MINUTE, gcTime: 30 * MINUTE },
  rules: { staleTime: DAY, gcTime: 2 * DAY },
  scenarios: { staleTime: HOUR, gcTime: DAY },
} as const;

/** Query keys; the heatmap key extends the plan key, so invalidating a plan refreshes both. */
export const queryKeys = {
  all: ["api"] as const,
  geocode: (query: string, limit?: number) => ["api", "geocode", query, limit ?? null] as const,
  plan: (planId: string) => ["api", "plan", planId] as const,
  heatmap: (planId: string) => ["api", "plan", planId, "heatmap"] as const,
  rules: () => ["api", "rules"] as const,
  scenarios: () => ["api", "scenarios"] as const,
  createPlan: () => ["api", "create-plan"] as const,
};

/**
 * A QueryClient with the defaults the API layer expects: no query-level retries (the client already
 * retries idempotent GETs with jitter), no refetch on window focus (plans are immutable).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

const ApiClientContext = createContext<ApiClient>(createApiClient());

/** Supplies the API client to the hooks below (tests and the integration build override it). */
export function ApiClientProvider({
  client,
  children,
}: {
  readonly client: ApiClient;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

/** The API client in context (a default same-origin `/api/v1` client without a provider). */
export function useApiClient(): ApiClient {
  return useContext(ApiClientContext);
}

/** The server's query normalisation (NFKC, trimmed, whitespace collapsed); case is kept. */
export function normalizeGeocodeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** Whether a normalised query is 2..120 characters (code points), the range the API accepts. */
export function isGeocodeQuery(normalized: string): boolean {
  const length = Array.from(normalized).length;
  return length >= 2 && length <= 120;
}

/**
 * Autocomplete suggestions. Debounce the input before passing it in (>= 250 ms in the form); the
 * query is disabled below 2 characters, and the previous suggestions stay visible while the next
 * ones load. Equivalent queries (case, spacing) share one cache entry.
 */
export function useGeocode(
  query: string,
  options: { readonly limit?: number | undefined } = {},
): UseQueryResult<GeocodeResponse, ApiError> {
  const client = useApiClient();
  const normalized = normalizeGeocodeQuery(query);
  return useQuery<GeocodeResponse, ApiError>({
    queryKey: queryKeys.geocode(normalized.toLowerCase(), options.limit),
    queryFn: ({ signal }) => client.geocode(normalized, { limit: options.limit, signal }),
    enabled: isGeocodeQuery(normalized),
    placeholderData: keepPreviousData,
    ...CACHE_POLICY.geocode,
  });
}

/** A stored plan; disabled (no request) until `planId` has the shape of a plan id. */
export function usePlan(planId: string | null | undefined): UseQueryResult<Plan, ApiError> {
  const client = useApiClient();
  const id = isPlanId(planId) ? planId : null;
  return useQuery<Plan, ApiError>({
    queryKey: queryKeys.plan(id ?? ""),
    queryFn: id === null ? skipToken : ({ signal }) => client.getPlan(id, { signal }),
    ...CACHE_POLICY.plan,
  });
}

/** The 49-frame corridor forecast of a plan (large: structural sharing is off to skip deep compares). */
export function useHeatmap(planId: string | null | undefined): UseQueryResult<Heatmap, ApiError> {
  const client = useApiClient();
  const id = isPlanId(planId) ? planId : null;
  return useQuery<Heatmap, ApiError>({
    queryKey: queryKeys.heatmap(id ?? ""),
    queryFn: id === null ? skipToken : ({ signal }) => client.getHeatmap(id, { signal }),
    structuralSharing: false,
    ...CACHE_POLICY.heatmap,
  });
}

/** The risk rules document as the server serves it. */
export function useRules(): UseQueryResult<RiskRules, ApiError> {
  const client = useApiClient();
  return useQuery<RiskRules, ApiError>({
    queryKey: queryKeys.rules(),
    queryFn: ({ signal }) => client.getRules({ signal }),
    ...CACHE_POLICY.rules,
  });
}

/** The demo weather scenarios. */
export function useScenarios(): UseQueryResult<Scenario[], ApiError> {
  const client = useApiClient();
  return useQuery<Scenario[], ApiError>({
    queryKey: queryKeys.scenarios(),
    queryFn: ({ signal }) => client.getScenarios({ signal }),
    ...CACHE_POLICY.scenarios,
  });
}

/** The plan-creation mutation plus `cancel()` for a Cancel button. */
export type CreatePlanResult = UseMutationResult<Plan, ApiError, PlanRequest> & {
  /** Aborts the request in flight (if any) and returns the mutation to idle. */
  readonly cancel: () => void;
};

/**
 * Creates a plan. Submitting again while a request is in flight aborts the earlier one (its promise
 * rejects with code `aborted`, which `isAbortedError` recognises) and only the latest submission
 * drives `status`/`data`/`error`. A successful plan is written into the `usePlan` cache.
 * `cancel()` and unmounting abort every submission that has not settled, including one TanStack
 * Query has accepted but not started yet: that request is never sent. `variables` is a copy of the
 * request that was submitted.
 */
export function useCreatePlan(): CreatePlanResult {
  const client = useApiClient();
  const queryClient = useQueryClient();
  /**
   * The abort handle of every submission that has not settled, keyed by the object TanStack Query
   * hands to `mutationFn`. A handle exists from the moment of `mutate()`, not from the moment
   * `mutationFn` starts a few microtasks later, so a cancel in between is not lost.
   */
  const [submissions] = useState(() => new Map<PlanRequest, AbortController>());

  const controllerFor = useCallback(
    (submitted: PlanRequest): AbortController => {
      let controller = submissions.get(submitted);
      if (controller === undefined) {
        controller = new AbortController();
        submissions.set(submitted, controller);
      }
      return controller;
    },
    [submissions],
  );

  const abortAll = useCallback(() => {
    for (const controller of submissions.values()) controller.abort();
  }, [submissions]);

  const mutation = useMutation<Plan, ApiError, PlanRequest>({
    mutationKey: queryKeys.createPlan(),
    mutationFn: async (submitted) => {
      try {
        return await client.createPlan(submitted, { signal: controllerFor(submitted).signal });
      } finally {
        submissions.delete(submitted);
      }
    },
    onSuccess: (plan) => {
      queryClient.setQueryData(queryKeys.plan(plan.plan_id), plan);
    },
  });

  useEffect(() => abortAll, [abortAll]);

  /** Registers a submission: it supersedes the earlier ones and gets an identity of its own. */
  const begin = useCallback(
    (request: PlanRequest): PlanRequest => {
      abortAll();
      const submitted = { ...request };
      controllerFor(submitted);
      return submitted;
    },
    [abortAll, controllerFor],
  );

  const { mutate: run, mutateAsync: runAsync, reset } = mutation;
  const mutate = useCallback<CreatePlanResult["mutate"]>(
    (request, options) => {
      run(begin(request), options);
    },
    [begin, run],
  );
  const mutateAsync = useCallback<CreatePlanResult["mutateAsync"]>(
    (request, options) => runAsync(begin(request), options),
    [begin, runAsync],
  );
  const cancel = useCallback(() => {
    abortAll();
    reset();
  }, [abortAll, reset]);

  return { ...mutation, mutate, mutateAsync, cancel };
}
