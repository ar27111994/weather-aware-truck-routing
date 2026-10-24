import type { SetupServer } from "msw/node";
import { afterEach } from "vitest";

const UPSTREAM_ISSUE = "https://github.com/mswjs/interceptors/issues/862";

/**
 * A `fetch` that asks for a fresh socket on every request.
 *
 * WORKAROUND for {@link UPSTREAM_ISSUE} (open on msw 3.0.3 and @mswjs/interceptors 0.45.9, the newest
 * releases). MSW intercepts Node's `fetch` at the socket, and a request that reuses a kept-alive
 * socket can still go to the real network (`ENOTFOUND api.test`) while its mock handler holds it, so
 * a test fails at random: `PlannerPage.test.tsx` alone failed in 25 of 80 CI runs. `Connection: close`
 * makes undici drop the socket after each response, so no request reuses one: 0 failures in 80 runs.
 *
 * Remove this file, and every use of `closeConnections` and `requireClosedConnections`, when a
 * release of msw or @mswjs/interceptors closes that issue. Prove it first: run the single-file probe
 * without the workaround (at least 80 fresh-process runs, 0 failures).
 */
export const closeConnections: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  request.headers.set("connection", "close");
  return globalThis.fetch(request);
};

/** True when the request does not ask to close its connection, so its socket may be reused. */
export function keepsSocketAlive(request: Request): boolean {
  return request.headers.get("connection")?.toLowerCase() !== "close";
}

/** What {@link watchKeepAlive} found. */
export interface KeepAliveWatch {
  /** Throws, naming each request once, when a request since the last call kept its socket alive. */
  readonly check: () => void;
}

/** Records every request that reaches `server` on a socket that may be reused. */
export function watchKeepAlive(server: SetupServer): KeepAliveWatch {
  const kept: string[] = [];
  server.events.on("request:start", ({ request }) => {
    if (keepsSocketAlive(request)) {
      const connection = String(request.headers.get("connection"));
      kept.push(`${request.method} ${request.url} (connection: ${connection})`);
    }
  });
  return {
    check(): void {
      const found = kept.splice(0);
      if (found.length === 0) return;
      const noun = found.length === 1 ? "request" : "requests";
      throw new Error(
        [
          `${String(found.length)} ${noun} reached the mock server on a socket that may be reused:`,
          ...found.map((line) => `  ${line}`),
          `MSW can let a request on a reused socket go to the real network while its handler holds it, so the test fails at random: ${UPSTREAM_ISSUE}`,
          "Send it through `closeConnections` (frontend/test/close-connections.ts), or take `client` from `startMockApi()`.",
        ].join("\n"),
      );
    },
  };
}

/**
 * Fails, after each test, the test that sent a request on a socket that may be reused. Call it once,
 * at the top level of a test file, for the server that the file listens on.
 */
export function requireClosedConnections(server: SetupServer): void {
  const watch = watchKeepAlive(server);
  afterEach(() => {
    watch.check();
  });
}
