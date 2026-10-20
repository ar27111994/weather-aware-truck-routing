import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import type { ReactElement, ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "./client";
import type { PlanRequest } from "./contract";
import { ApiError, CLIENT_ERROR_CODES, isAbortedError } from "./errors";
import { minimalHeatmap, minimalPlan, minimalRules, MINIMAL_PLAN_ID } from "./mocks/minimal";
import {
  ApiClientProvider,
  CACHE_POLICY,
  createQueryClient,
  isGeocodeQuery,
  normalizeGeocodeQuery,
  queryKeys,
  useApiClient,
  useCreatePlan,
  useGeocode,
  useHeatmap,
  usePlan,
  useRules,
  useScenarios,
} from "./queries";

const BASE = "http://api.test/api/v1";
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const request: PlanRequest = {
  origin: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" },
  destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
  departure_time: "2026-10-20T14:00:00Z",
  load_weight_lb: 38000,
  sampling_interval_mi: 25,
  scenario: null,
};

function problem(status: number, code: string): Response {
  return HttpResponse.json(
    { title: code, status, code },
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

function setup(client: ApiClient = createApiClient({ baseUrl: BASE })): {
  queryClient: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/** Resolves when `release()` is called; lets a client stub hold a request open. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/**
 * A request that stays open until its signal aborts, then fails the way the real client does.
 *
 * Requests are held in a client stub, never in an MSW handler: @mswjs/interceptors 0.45.x aborts a
 * request whose handler is still pending as soon as its background real-socket attempt errors
 * (`Socket.#onRealSocketError` -> `abortPendingRequest`), ~10-100 ms after the handler was entered
 * and without any caller involvement. A held request would race that abort. The hooks only depend
 * on the client contract; `client.test.ts` covers how a real `fetch` abort maps to `aborted`.
 */
function heldUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        reject(
          new ApiError({ status: 0, code: CLIENT_ERROR_CODES.aborted, title: "Request cancelled" }),
        );
      },
      { once: true },
    );
  });
}

describe("query keys and cache policy", () => {
  it("builds hierarchical keys where the heatmap sits under its plan", () => {
    expect(queryKeys.geocode("den", 3)).toEqual(["api", "geocode", "den", 3]);
    expect(queryKeys.geocode("den")).toEqual(["api", "geocode", "den", null]);
    expect(queryKeys.plan("pln_x")).toEqual(["api", "plan", "pln_x"]);
    expect(queryKeys.heatmap("pln_x").slice(0, 3)).toEqual(queryKeys.plan("pln_x"));
    expect(queryKeys.rules()).toEqual(["api", "rules"]);
    expect(queryKeys.scenarios()).toEqual(["api", "scenarios"]);
    expect(queryKeys.createPlan()).toEqual(["api", "create-plan"]);
    expect(queryKeys.all).toEqual(["api"]);
  });

  it("derives freshness from the contract's Cache-Control values", () => {
    expect(CACHE_POLICY.geocode.staleTime).toBe(86_400_000);
    expect(CACHE_POLICY.plan.staleTime).toBe(300_000);
    expect(CACHE_POLICY.heatmap.staleTime).toBe(300_000);
  });

  it("creates a QueryClient without query retries or focus refetching", () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.queries?.retry).toBe(false);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.mutations?.retry).toBe(false);
  });
});

describe("geocode query helpers", () => {
  it("normalises like the server: NFKC, trim, collapsed spaces, case kept", () => {
    expect(normalizeGeocodeQuery("  Den\u00a0 ver  ")).toBe("Den ver");
    expect(normalizeGeocodeQuery("\uff24enver")).toBe("Denver");
  });

  it("accepts 2..120 characters, counting code points", () => {
    expect(isGeocodeQuery("")).toBe(false);
    expect(isGeocodeQuery("d")).toBe(false);
    expect(isGeocodeQuery("de")).toBe(true);
    expect(isGeocodeQuery("x".repeat(120))).toBe(true);
    expect(isGeocodeQuery("x".repeat(121))).toBe(false);
    expect(isGeocodeQuery("\u{1f69a}\u{1f69a}")).toBe(true);
    expect(isGeocodeQuery("\u{1f69a}")).toBe(false);
  });
});

describe("ApiClientProvider", () => {
  it("falls back to a default client and honours an overriding provider", () => {
    const fallback = renderHook(() => useApiClient());
    expect(typeof fallback.result.current.geocode).toBe("function");

    const custom = createApiClient({ baseUrl: BASE });
    const provided = renderHook(() => useApiClient(), {
      wrapper: ({ children }) => <ApiClientProvider client={custom}>{children}</ApiClientProvider>,
    });
    expect(provided.result.current).toBe(custom);
  });
});

describe("useGeocode", () => {
  it("stays idle below two characters and never calls the API", () => {
    // renderHook flushes effects, so an enabled query would already have called the client here.
    const geocode = vi.fn(() => Promise.reject(new Error("must not be called")));
    const client: ApiClient = { ...createApiClient({ baseUrl: BASE }), geocode };
    const { wrapper } = setup(client);

    const { result } = renderHook(() => useGeocode(" d "), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.status).toBe("pending");
    expect(geocode).not.toHaveBeenCalled();
  });

  it("fetches normalised suggestions with the limit and returns validated data", async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE}/geocode`, ({ request: incoming }) => {
        seen.push(new URL(incoming.url).search);
        return HttpResponse.json({ query: "denver", results: [] });
      }),
    );
    const { wrapper } = setup();

    const { result } = renderHook(() => useGeocode("  Denver ", { limit: 3 }), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual({ query: "denver", results: [] });
    expect(seen).toEqual(["?q=Denver&limit=3"]);
  });

  it("shares one cache entry between spellings that differ only in case and spacing", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/geocode`, () => {
        calls += 1;
        return HttpResponse.json({ query: "denver", results: [] });
      }),
    );
    const { wrapper } = setup();

    const first = renderHook(() => useGeocode("Denver"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    const second = renderHook(() => useGeocode("  denver "), { wrapper });
    await waitFor(() => {
      expect(second.result.current.isSuccess).toBe(true);
    });

    expect(calls).toBe(1);
  });

  it("keeps the previous suggestions visible while the next query loads", async () => {
    const next = gate();
    const client: ApiClient = {
      ...createApiClient({ baseUrl: BASE }),
      geocode: (query) =>
        query === "den"
          ? Promise.resolve({ query: "den", results: [] })
          : next.wait.then(() => ({ query: "denv", results: [] })),
    };
    const { wrapper } = setup(client);

    const { result, rerender } = renderHook(({ q }) => useGeocode(q), {
      wrapper,
      initialProps: { q: "den" },
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    rerender({ q: "denv" });

    await waitFor(() => {
      expect(result.current.isPlaceholderData).toBe(true);
    });
    expect(result.current.data?.query).toBe("den");
    next.release();
    await waitFor(() => {
      expect(result.current.data?.query).toBe("denv");
    });
  });

  it("surfaces a server problem as a typed ApiError", async () => {
    server.use(http.get(`${BASE}/geocode`, () => problem(429, "rate_limited")));
    const { wrapper } = setup(createApiClient({ baseUrl: BASE, retry: { maxRetries: 0 } }));

    const { result } = renderHook(() => useGeocode("denver"), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryable: true,
    });
  });

  it("hands the query's AbortSignal to the client so superseded requests are cancelled", async () => {
    const signals: AbortSignal[] = [];
    const base = createApiClient({ baseUrl: BASE });
    const client: ApiClient = {
      ...base,
      geocode: (_query, options) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise(() => undefined);
      },
    };
    const { wrapper, queryClient } = setup(client);

    renderHook(() => useGeocode("denver"), { wrapper });
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);

    await act(async () => {
      await queryClient.cancelQueries();
    });

    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("usePlan and useHeatmap", () => {
  it.each([[null], [undefined], ["not-a-plan-id"], ["pln_short"]])(
    "send nothing for the id %j",
    (id) => {
      const seen: string[] = [];
      server.use(
        http.get(`${BASE}/*`, ({ request: incoming }) => {
          seen.push(incoming.url);
          return HttpResponse.json({});
        }),
      );
      const { wrapper } = setup();

      const plan = renderHook(() => usePlan(id), { wrapper });
      const heatmap = renderHook(() => useHeatmap(id), { wrapper });

      expect(plan.result.current.fetchStatus).toBe("idle");
      expect(heatmap.result.current.fetchStatus).toBe("idle");
      expect(seen).toEqual([]);
    },
  );

  it("loads a stored plan and its heatmap", async () => {
    server.use(
      http.get(`${BASE}/plans/${MINIMAL_PLAN_ID}`, () => HttpResponse.json(minimalPlan())),
      http.get(`${BASE}/plans/${MINIMAL_PLAN_ID}/heatmap`, () =>
        HttpResponse.json(minimalHeatmap()),
      ),
    );
    const { wrapper } = setup();

    const plan = renderHook(() => usePlan(MINIMAL_PLAN_ID), { wrapper });
    const heatmap = renderHook(() => useHeatmap(MINIMAL_PLAN_ID), { wrapper });

    await waitFor(() => {
      expect(plan.result.current.isSuccess).toBe(true);
    });
    await waitFor(() => {
      expect(heatmap.result.current.isSuccess).toBe(true);
    });
    expect(plan.result.current.data?.plan_id).toBe(MINIMAL_PLAN_ID);
    expect(heatmap.result.current.data?.frame_count).toBe(49);
  });

  it("reports an unknown plan as a 404 ApiError without retrying", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/plans/${MINIMAL_PLAN_ID}`, () => {
        calls += 1;
        return problem(404, "plan_not_found");
      }),
    );
    const { wrapper } = setup();

    const { result } = renderHook(() => usePlan(MINIMAL_PLAN_ID), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toMatchObject({ status: 404, code: "plan_not_found" });
    expect(calls).toBe(1);
  });

  it("turns a malformed plan payload into invalid_response instead of crashing", async () => {
    server.use(
      http.get(`${BASE}/plans/${MINIMAL_PLAN_ID}`, () =>
        HttpResponse.json({ plan_id: MINIMAL_PLAN_ID }),
      ),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlan(MINIMAL_PLAN_ID), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.code).toBe("invalid_response");
  });
});

describe("useRules and useScenarios", () => {
  it("load the rules document and the scenario list", async () => {
    server.use(
      http.get(`${BASE}/rules`, () => HttpResponse.json(minimalRules())),
      http.get(`${BASE}/scenarios`, () =>
        HttpResponse.json([{ id: "calm", name: "Calm", description: "d" }]),
      ),
    );
    const { wrapper } = setup();

    const rules = renderHook(() => useRules(), { wrapper });
    const scenarios = renderHook(() => useScenarios(), { wrapper });

    await waitFor(() => {
      expect(rules.result.current.isSuccess).toBe(true);
    });
    await waitFor(() => {
      expect(scenarios.result.current.isSuccess).toBe(true);
    });
    expect(rules.result.current.data?.version).toBe(minimalRules().version);
    expect(scenarios.result.current.data).toEqual([{ id: "calm", name: "Calm", description: "d" }]);
  });
});

describe("useCreatePlan", () => {
  it("creates a plan, exposes it and seeds the usePlan cache", async () => {
    server.use(http.post(`${BASE}/plans`, () => HttpResponse.json(minimalPlan(), { status: 201 })));
    const { wrapper, queryClient } = setup();

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      result.current.mutate(request);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.plan_id).toBe(MINIMAL_PLAN_ID);
    expect(queryClient.getQueryData(queryKeys.plan(MINIMAL_PLAN_ID))).toEqual(result.current.data);
  });

  it("exposes a 422 validation problem as a typed error and never retries the POST", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/plans`, () => {
        calls += 1;
        return problem(422, "departure_out_of_range");
      }),
    );
    const { wrapper } = setup();

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      result.current.mutate(request);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toMatchObject({ status: 422, code: "departure_out_of_range" });
    expect(calls).toBe(1);
  });

  it("aborts the earlier submission when a newer one starts and only reports the latest", async () => {
    const signals: AbortSignal[] = [];
    const client: ApiClient = {
      ...createApiClient({ baseUrl: BASE }),
      createPlan: (submitted, options) => {
        if (submitted.load_weight_lb !== 1000) return Promise.resolve(minimalPlan());
        if (options?.signal) signals.push(options.signal);
        return heldUntilAborted(options?.signal);
      },
    };
    const { wrapper } = setup(client);

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    let superseded: Promise<unknown> = Promise.resolve();
    act(() => {
      superseded = result.current
        .mutateAsync({ ...request, load_weight_lb: 1000 })
        .catch((error: unknown) => error);
    });
    // The client holds the first request, so it is in flight whatever the event loop is doing.
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    act(() => {
      result.current.mutate({ ...request, load_weight_lb: 2000 });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(isAbortedError(await superseded)).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("cancel() aborts the request in flight and returns the mutation to idle", async () => {
    const signals: AbortSignal[] = [];
    const client: ApiClient = {
      ...createApiClient({ baseUrl: BASE }),
      createPlan: (_request, options) => {
        if (options?.signal) signals.push(options.signal);
        return heldUntilAborted(options?.signal);
      },
    };
    const { wrapper } = setup(client);

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      result.current.mutate(request);
    });
    // The client holds the request, so it is in flight whatever the event loop is doing; the
    // `waitFor`s only let React catch up with state that cannot change before the next step.
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    expect(signals[0]?.aborted).toBe(false);

    act(() => {
      result.current.cancel();
    });

    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => {
      expect(result.current.isIdle).toBe(true);
    });
  });

  it("cancel() with nothing in flight is a harmless reset", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.isIdle).toBe(true);
  });

  it("cancel() in the same tick as mutate() stops the request before it is sent", async () => {
    let received = 0;
    server.use(
      http.post(`${BASE}/plans`, () => {
        received += 1;
        return HttpResponse.json(minimalPlan(), { status: 201 });
      }),
    );
    const { wrapper, queryClient } = setup();

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.mutateAsync(request).catch((error: unknown) => error);
      result.current.cancel();
    });

    expect(isAbortedError(await outcome)).toBe(true);
    expect(received).toBe(0);
    expect(queryClient.getQueryData(queryKeys.plan(MINIMAL_PLAN_ID))).toBeUndefined();
  });

  it("unmounting in the same tick as mutate() stops the request before it is sent", async () => {
    let received = 0;
    server.use(
      http.post(`${BASE}/plans`, () => {
        received += 1;
        return HttpResponse.json(minimalPlan(), { status: 201 });
      }),
    );
    const { wrapper } = setup();

    const view = renderHook(() => useCreatePlan(), { wrapper });
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = view.result.current.mutateAsync(request).catch((error: unknown) => error);
      view.unmount();
    });

    expect(isAbortedError(await outcome)).toBe(true);
    expect(received).toBe(0);
  });

  it("aborts an in-flight request on unmount, and unmounting idle does nothing", async () => {
    const held = gate();
    const signals: AbortSignal[] = [];
    const base = createApiClient({ baseUrl: BASE });
    const client: ApiClient = {
      ...base,
      createPlan: (_request, options) => {
        if (options?.signal) signals.push(options.signal);
        return held.wait.then(() => minimalPlan());
      },
    };
    const { wrapper } = setup(client);

    const idle = renderHook(() => useCreatePlan(), { wrapper });
    idle.unmount();

    const busy = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      busy.result.current.mutate(request);
    });
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    busy.unmount();

    expect(signals[0]?.aborted).toBe(true);
    held.release();
  });

  it("clears its in-flight marker once the request settles", async () => {
    const createPlan = vi.fn<ApiClient["createPlan"]>().mockResolvedValue(minimalPlan());
    const client: ApiClient = { ...createApiClient({ baseUrl: BASE }), createPlan };
    const { wrapper } = setup(client);

    const { result } = renderHook(() => useCreatePlan(), { wrapper });
    act(() => {
      result.current.mutate(request);
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    act(() => {
      result.current.mutate(request);
    });
    await waitFor(() => {
      expect(createPlan).toHaveBeenCalledTimes(2);
    });

    const secondSignal = createPlan.mock.calls[1]?.[1]?.signal;
    expect(secondSignal?.aborted).toBe(false);
  });
});
