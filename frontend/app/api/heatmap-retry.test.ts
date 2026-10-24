import { renderHook, waitFor } from "@testing-library/react";
import { http } from "msw/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_BASE, apiWrapper, startMockApi } from "../../test/api";
import { closeConnections } from "../../test/close-connections";
import { createApiClient, type ApiClient } from "./client";
import { mockPlanId, problemResponse } from "./mocks";
import { useHeatmap } from "./queries";

/*
 * Q6 (R4F). In a keyboard walk one failing heatmap (503) made three GETs although the query client
 * says `retry: false`. The three are the client's own: the first try and `DEFAULT_RETRY_POLICY`'s
 * two retries. `createQueryClient()` adds none, so a failure is 3 requests and not 3 x 3. We keep
 * that (reasons in `README.md`, "Retries and request counts"). These tests send the real client,
 * with its default policy, through MSW and count at the mock server's handler, so a change of
 * `maxRetries`, of the delays, of the `Retry-After` cap or of the query layer's `retry: false`
 * fails here.
 */

const PLAN_ID = mockPlanId("heatmap-retry");
/** Real milliseconds a request that must NOT happen is given to show up. */
const QUIET_WINDOW_MS = 50;
/** Real milliseconds a request that must happen is given to show up, before the test says so. */
const PATIENCE_MS = 3_000;

const { server } = startMockApi();

// Taken before any test fakes the clock: the waits below must run on the real one.
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

afterEach(() => {
  vi.useRealTimers();
});

/** Answers every heatmap request with a 503 and records, at the handler, the plan id it asked for. */
function failHeatmaps(retryAfterS?: number): string[] {
  const hits: string[] = [];
  server.use(
    http.get(`${API_BASE}/plans/:planId/heatmap`, ({ params }) => {
      hits.push(String(params["planId"]));
      return problemResponse(
        503,
        "weather_capacity_exhausted",
        "Weather capacity exhausted",
        retryAfterS === undefined ? {} : { retryAfterS },
      );
    }),
  );
  return hits;
}

/**
 * A client with the default retry policy; only the jitter is fixed, so the waits can be read.
 * `answered` gets the attempt number of every response the client has read. A response is read in
 * a microtask, and the client then schedules its wait in the same drain of microtasks, so once
 * `answered` has grown, the wait already exists.
 */
function clientWithJitter(jitter: number): { client: ApiClient; answered: number[] } {
  const answered: number[] = [];
  const client = createApiClient({
    baseUrl: API_BASE,
    fetch: closeConnections,
    random: () => jitter,
    onResponse: (info) => answered.push(info.attempt),
  });
  return { client, answered };
}

/** Only the timers the backoff uses are faked: MSW and the network stack keep the real ones. */
function fakeTheBackoffClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** A call in flight: `settled` turns true when it ends, `error` is how (`null` when it succeeded). */
interface Watched {
  settled: boolean;
  error: unknown;
}

function watch(call: Promise<unknown>): Watched {
  const watched: Watched = { settled: false, error: null };
  void call.then(
    () => {
      watched.settled = true;
    },
    (error: unknown) => {
      watched.error = error;
      watched.settled = true;
    },
  );
  return watched;
}

/** One trip around the event loop: MSW answers, the client takes its next step. */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    realSetImmediate(resolve);
  });
}

/** Lets everything that is already due happen, without moving the fake clock. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, QUIET_WINDOW_MS);
  });
}

/** Waits on the real clock, not moving the fake one, until `ready` holds; fails with `what`. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + PATIENCE_MS;
  while (!ready()) {
    if (Date.now() > giveUpAt)
      throw new Error(`gave up waiting ${String(PATIENCE_MS)} ms for ${what}`);
    await turn();
  }
}

describe("Q6: a failing heatmap GET is three requests, by decision (two client retries, no query retry)", () => {
  it("makes exactly three GETs for a 503: the first try and two retries, 150 ms then 300 ms later", async () => {
    const hits = failHeatmaps();
    const { client, answered } = clientWithJitter(0.5);
    fakeTheBackoffClock();

    const call = watch(client.getHeatmap(PLAN_ID));

    // Full jitter at 0.5: 0.5 x min(4000, 300 x 2^0) = 150 ms, then 0.5 x min(4000, 300 x 2^1) = 300 ms.
    await until(() => answered.length === 1, "the first answer");
    await vi.advanceTimersByTimeAsync(149);
    await settle();
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => answered.length === 2, "the first retry's answer");
    await vi.advanceTimersByTimeAsync(299);
    await settle();
    expect(hits).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await until(() => call.settled, "the call to end after its second retry");
    expect(call.error).toMatchObject({ status: 503, code: "weather_capacity_exhausted" });
    // The third failure is final: no wait is left and no fourth request comes, however long it runs.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(hits).toEqual([PLAN_ID, PLAN_ID, PLAN_ID]);
    expect(answered).toEqual([1, 2, 3]);
  });

  it("makes one GET, not three, when the 503 asks for more than ten seconds: the UI shows the wait", async () => {
    const hits = failHeatmaps(30);
    const { client, answered } = clientWithJitter(0.5);
    fakeTheBackoffClock();

    const call = watch(client.getHeatmap(PLAN_ID));

    await until(() => call.settled, "the call to give up at once");
    expect(call.error).toMatchObject({ status: 503, retryAfterS: 30 });
    expect(hits).toHaveLength(1);
    expect(answered).toEqual([1]);
  });

  it("sends nothing more once the caller leaves during the first wait", async () => {
    const hits = failHeatmaps();
    const { client, answered } = clientWithJitter(0.5);
    const controller = new AbortController();
    fakeTheBackoffClock();

    const call = watch(client.getHeatmap(PLAN_ID, { signal: controller.signal }));
    await until(() => answered.length === 1, "the first answer");
    controller.abort();

    await until(() => call.settled, "the call to end when its caller leaves");
    expect(call.error).toMatchObject({ code: "aborted" });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(hits).toHaveLength(1);
  });

  it("is still three GETs through useHeatmap: createQueryClient adds no retry of its own", async () => {
    const hits = failHeatmaps();
    // Jitter 0 makes every wait 0 ms: this test counts requests, the first one measures the waits.
    const { client } = clientWithJitter(0);

    const { result } = renderHook(() => useHeatmap(PLAN_ID), { wrapper: apiWrapper(client) });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(hits).toHaveLength(3);
    // The query layer saw one failure: the other two requests were the client's own retries.
    expect(result.current.failureCount).toBe(1);
    expect(result.current.error).toMatchObject({ status: 503, code: "weather_capacity_exhausted" });
  });
});
