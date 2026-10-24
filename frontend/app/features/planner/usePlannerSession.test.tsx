import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, delay, http } from "msw";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiWrapper, startMockApi } from "../../../test/api";
import { DENVER, SLC, requestFor } from "../../../test/plans";
import { problemResponse } from "../../api/mocks/handlers";
import { tripStore } from "../../state";
import { buildTripSearch, parseTripSearch } from "./trip-url";
import { usePlannerSession } from "./usePlannerSession";

const api = startMockApi();

// Real requests through a mock server, on a machine running other jobs.
vi.setConfig({ testTimeout: 30_000 });

/** The planner's data together with the address it keeps. */
function useSession(): { session: ReturnType<typeof usePlannerSession>; search: string } {
  const session = usePlannerSession();
  return { session, search: useLocation().search };
}

function setup(search = ""): { readonly current: ReturnType<typeof useSession> } {
  const Api = apiWrapper(api.client);
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <Api>
      <MemoryRouter initialEntries={[`/${search}`]}>{children}</MemoryRouter>
    </Api>
  );
  return renderHook(useSession, { wrapper }).result;
}

beforeEach(() => {
  act(() => {
    tripStore.actions.selectRoute(null);
  });
});

describe("usePlannerSession: the address", () => {
  it("reads the inputs and the plan id the address carries", () => {
    const search = buildTripSearch({
      origin: SLC,
      destination: DENVER,
      load: 20_000,
      interval: 10,
    });
    const { current } = setup(search);

    expect(current.session.inputs).toEqual({
      origin: SLC,
      destination: DENVER,
      load: 20_000,
      interval: 10,
    });
    expect(current.session.search).toBe(search);
    expect(current.session.plan).toBeNull();
    expect(current.session.planState).toBe("ready");
    expect(current.session.heatmapState).toBe("idle");
    expect(current.session.error).toBeNull();
  });

  it("makes a plan, puts its address in the bar and loads its corridor forecast", async () => {
    api.server.use(
      http.post("*/api/v1/plans", async () => {
        await delay(150);
        return undefined;
      }),
    );
    const result = setup();

    act(() => {
      result.current.session.submit(requestFor({ scenario: "calm", sampling_interval_mi: 50 }));
    });
    await waitFor(() => {
      expect(result.current.session.planState).toBe("loading");
    });
    await waitFor(() => {
      expect(result.current.session.plan).not.toBeNull();
    });
    const plan = result.current.session.plan;
    const state = parseTripSearch(result.current.search);
    expect(state.plan).toBe(plan?.plan_id);
    expect(state.interval).toBe(50);
    expect(state.scenario).toBe("calm");
    expect(state.origin).toEqual(SLC);
    await waitFor(() => {
      expect(result.current.session.heatmapState).toBe("ready");
    });
    expect(result.current.session.heatmap).toBeDefined();
    expect(tripStore.getState().selectedRouteId).toBe(plan?.recommendation.route_id);
  });

  it("keeps the visitor's request to see the plan for the panel built for it, and gives it once", async () => {
    const result = setup();

    act(() => {
      result.current.session.submit(requestFor({ scenario: "calm", sampling_interval_mi: 50 }));
    });
    await waitFor(() => {
      expect(result.current.session.plan).not.toBeNull();
    });
    const planId = result.current.session.plan?.plan_id ?? "";

    expect(result.current.session.consumeFocusRequest("another-plan")).toBe(false);
    expect(result.current.session.consumeFocusRequest(planId)).toBe(true);
    expect(result.current.session.consumeFocusRequest(planId)).toBe(false);
  });

  it("makes no request to see a plan that the address names", async () => {
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));
    const result = setup(buildTripSearch({ origin: SLC, destination: DENVER, plan: made.plan_id }));
    await waitFor(() => {
      expect(result.current.session.plan).not.toBeNull();
    });

    expect(result.current.session.consumeFocusRequest(made.plan_id)).toBe(false);
  });

  it("leaves the scenario out of the address for the live forecast", async () => {
    const result = setup();

    act(() => {
      result.current.session.submit(requestFor({ scenario: null, sampling_interval_mi: 50 }));
    });

    await waitFor(() => {
      expect(parseTripSearch(result.current.search).plan).toBeDefined();
    });
    expect(result.current.search).not.toContain("scenario=");
  });

  it("restores a plan from its id", async () => {
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));
    const result = setup(buildTripSearch({ plan: made.plan_id }));

    expect(result.current.session.planState).toBe("loading");
    await waitFor(() => {
      expect(result.current.session.plan?.plan_id).toBe(made.plan_id);
    });
    expect(result.current.session.planState).toBe("ready");
  });
});

describe("usePlannerSession: two requests at once", () => {
  it("lets the later request win and never reports the aborted one as a failure", async () => {
    const loads: number[] = [];
    api.server.use(
      http.post("*/api/v1/plans", async ({ request }) => {
        const body = (await request.clone().json()) as { load_weight_lb: number };
        loads.push(body.load_weight_lb);
        if (loads.length === 1) await delay("infinite");
        return undefined;
      }),
    );
    const result = setup();

    act(() => {
      result.current.session.submit(
        requestFor({ load_weight_lb: 38_000, sampling_interval_mi: 50 }),
      );
    });
    await waitFor(() => {
      expect(loads).toEqual([38_000]);
    });
    act(() => {
      result.current.session.submit(
        requestFor({ load_weight_lb: 20_000, sampling_interval_mi: 50 }),
      );
    });

    await waitFor(() => {
      expect(result.current.session.plan).not.toBeNull();
    });
    expect(result.current.session.plan?.request.load_weight_lb).toBe(20_000);
    expect(parseTripSearch(result.current.search).load).toBe(20_000);
    expect(result.current.session.error).toBeNull();
    expect(result.current.session.planState).toBe("ready");
  });
});

describe("usePlannerSession: failures", () => {
  it("reports a failed plan, and asks the same question again on retry", async () => {
    api.server.use(
      http.post(
        "*/api/v1/plans",
        () => problemResponse(502, "routing_unavailable", "Routing provider unavailable", {}),
        { once: true },
      ),
    );
    const result = setup();

    act(() => {
      result.current.session.submit(requestFor({ sampling_interval_mi: 50 }));
    });
    await waitFor(() => {
      expect(result.current.session.planState).toBe("error");
    });
    expect(result.current.session.error?.code).toBe("routing_unavailable");
    expect(result.current.session.plan).toBeNull();

    act(() => {
      result.current.session.retry();
    });

    await waitFor(() => {
      expect(result.current.session.plan).not.toBeNull();
    });
    expect(result.current.session.error).toBeNull();
  });

  it("reports a plan the address names that cannot be loaded, and asks for it again on retry", async () => {
    let failing = true;
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));
    api.server.use(
      http.get("*/api/v1/plans/:id", () =>
        failing
          ? problemResponse(502, "weather_unavailable", "Weather unavailable", {})
          : undefined,
      ),
    );
    const result = setup(buildTripSearch({ plan: made.plan_id }));
    await waitFor(() => {
      expect(result.current.session.planState).toBe("error");
    });
    expect(result.current.session.plan).toBeNull();
    failing = false;

    act(() => {
      result.current.session.retry();
    });

    await waitFor(() => {
      expect(result.current.session.plan?.plan_id).toBe(made.plan_id);
    });
  });

  it("reports a corridor forecast that failed, and asks for it again", async () => {
    let failing = true;
    const made = await api.client.createPlan(requestFor({ sampling_interval_mi: 50 }));
    api.server.use(
      http.get("*/api/v1/plans/:id/heatmap", () => (failing ? HttpResponse.error() : undefined)),
    );
    const result = setup(buildTripSearch({ plan: made.plan_id }));
    await waitFor(() => {
      expect(result.current.session.heatmapState).toBe("error");
    });
    failing = false;

    act(() => {
      result.current.session.retryHeatmap();
    });

    await waitFor(() => {
      expect(result.current.session.heatmapState).toBe("ready");
    });
  });
});
