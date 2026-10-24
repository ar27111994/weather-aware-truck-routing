import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { SetupServer } from "msw/node";
import type { ReactElement, ReactNode } from "react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { createApiClient, type ApiClient } from "../app/api/client";
import { probeLog } from "./probe";
import { createMockApi, type MockApi } from "../app/api/mocks";
import { createMockServer } from "../app/api/mocks/node";
import { ApiClientProvider, createQueryClient } from "../app/api/queries";

/** Where the mock API answers in tests (Node's `fetch` needs an absolute address). */
export const API_BASE = "http://api.test/api/v1";

export interface TestApi {
  /** The MSW server: add per-test handlers with `server.use(...)`. */
  readonly server: SetupServer;
  /** The in-memory backend behind the default handlers. */
  readonly api: MockApi;
  /** A client pointed at the mock server. */
  readonly client: ApiClient;
}

/**
 * Starts the mock API for the test file that calls it (listen before all, reset after each, close
 * after all) and returns it. Call it at the top level of the file, once.
 */
export function startMockApi(): TestApi {
  const api = createMockApi();
  const server = createMockServer(api);
  server.events.on("request:start", ({ request }) => {
    probeLog(`MSW start ${request.method} ${new URL(request.url).pathname}`);
  });
  server.events.on("request:match", ({ request }) => {
    probeLog(`MSW match ${request.method} ${new URL(request.url).pathname}`);
  });
  server.events.on("request:end", ({ request }) => {
    probeLog(`MSW end ${request.method} ${new URL(request.url).pathname}`);
  });
  server.events.on("unhandledException", ({ error, request }) => {
    probeLog(`MSW unhandledException ${request.method} ${request.url} ${String(error)}`);
  });
  server.events.on("request:unhandled", ({ request }) => {
    probeLog(`MSW request:unhandled ${request.method} ${request.url}`);
  });
  server.events.on("response:mocked", ({ request, response }) => {
    if (request.method === "POST") probeLog(`MSW responded ${request.method} ${request.url} ${String(response.status)}`);
  });
  const closeConnections = process.env["PROBE_CLOSE"] === "1";
  let counter = 0;
  let lastDoneAt = 0;
  const send: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const watch = init?.method === "POST" && url.endsWith("/plans");
    counter += 1;
    const number = counter;
    const idle = lastDoneAt === 0 ? -1 : Math.round(performance.now() - lastDoneAt);
    probeLog(`fetch#${String(number)} ${init?.method ?? "GET"} ${new URL(url).pathname} idleSinceLastDone=${String(idle)}ms`);
    const nextInit = closeConnections
      ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Connection: "close" } }
      : init;
    if (watch) {
      const handlers = server.listHandlers();
      const first = handlers[0] as { info?: { header?: string } } | undefined;
      probeLog(`POST handlers=${String(handlers.length)} first=${String(first?.info?.header)}`);
    }
    if (watch) probeLog(`POST /plans start signalAborted=${String(init.signal?.aborted)}`);
    try {
      const response = await globalThis.fetch(input, nextInit);
      lastDoneAt = performance.now();
      if (watch) probeLog(`POST /plans -> ${String(response.status)}`);
      return response;
    } catch (error) {
      lastDoneAt = performance.now();
      probeLog(`fetch#${String(number)} REJECTED ${String(error)} cause=${String((error as Error).cause)}`);
      throw error;
    }
  };
  // No retries: the API layer's own tests cover the backoff, and a failing GET would otherwise
  // take seconds to reach the error state a page test wants to look at.
  const client = createApiClient({ baseUrl: API_BASE, retry: { maxRetries: 0 }, fetch: send });
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
  return { server, api, client };
}

/**
 * A wrapper that gives the tree a fresh query cache and the given API client. Use it with
 * `renderHook(..., { wrapper })`, or through {@link renderWithApi}.
 */
export function apiWrapper(client: ApiClient): (props: { children: ReactNode }) => ReactElement {
  const queryClient = createQueryClient();
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>{children}</ApiClientProvider>
      </QueryClientProvider>
    );
  };
}

/** Renders `ui` with a fresh query cache and the given API client. */
export function renderWithApi(ui: ReactElement, client: ApiClient): RenderResult {
  return render(ui, { wrapper: apiWrapper(client) });
}
