/**
 * The Node-only entry of the mock API: an MSW server for Vitest and other Node processes.
 *
 * It lives apart from the `index.ts` barrel on purpose. `msw/node` imports Node built-ins, so any
 * browser bundle that reaches it breaks (a browser dev-mock bootstrap would import the barrel and use
 * `setupWorker` from `msw/browser` instead). `browser-barrel.test.ts` enforces the split.
 */
import { setupServer } from "msw/node";

import { createMockApi, type MockApi } from "./handlers";

/** A node (Vitest) server over a fresh mock backend; call `listen()` / `close()` yourself. */
export function createMockServer(api: MockApi = createMockApi()): ReturnType<typeof setupServer> {
  return setupServer(...api.handlers);
}
