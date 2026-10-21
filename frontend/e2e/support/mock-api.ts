import { test as base } from "@playwright/test";
import type { Page, Request as PageRequest } from "@playwright/test";
import { getResponse } from "msw";
import type { RequestHandler } from "msw";
import { createServer } from "vite";

import type * as Mocks from "../../app/api/mocks";

/** The app's mock API: MSW handlers over recorded trips, the same module the unit tests use. */
type MockModule = typeof Mocks;

/** What a test can see and change about the API the page talks to. */
export interface MockBackend {
  /** Handlers tried before the default ones, newest first, like MSW's `server.use`. */
  readonly use: (...handlers: RequestHandler[]) => void;
  /** Every request the page sent to the API, as `GET /api/v1/geocode?q=sal&limit=5`. */
  readonly requests: readonly string[];
  /** The plans made so far, by id. A test that opens a shared link adds its plan here first. */
  readonly plans: Mocks.MockApi["plans"];
  /** The mock module itself: `buildPlan`, `errorFixtures` and the rest. */
  readonly mocks: MockModule;
}

let loading: Promise<MockModule> | undefined;

/**
 * The mock API is the app's own TypeScript, and it imports JSON without an import attribute, which
 * Playwright's loader refuses. Vite's module loader resolves those imports exactly as the app's
 * build does, so the fixtures have one source: the files the unit tests already use. The server
 * has no port and no file watcher; its worker process ends with the run.
 */
function loadMocks(): Promise<MockModule> {
  loading ??= (async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    });
    return (await server.ssrLoadModule("/app/api/mocks/index.ts")) as MockModule;
  })();
  return loading;
}

/**
 * Answers every `/api/v1` request of the page from the mock API. The production build has no
 * backend behind it (`pnpm preview` serves files only), and CI never calls a live provider.
 */
async function installMockApi(page: Page): Promise<MockBackend> {
  const mocks = await loadMocks();
  const api = mocks.createMockApi();
  const extra: RequestHandler[] = [];
  const requests: string[] = [];
  // A request the page gave up on (a newer plan replaced it) must not be answered afterwards.
  const abandoned = new WeakSet<PageRequest>();
  page.on("requestfailed", (request) => {
    abandoned.add(request);
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const label = `${request.method()} ${url.pathname}${url.search}`;
    requests.push(label);
    const body = request.postDataBuffer();
    const response = await getResponse(
      [...extra, ...api.handlers],
      new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        // A copy backed by a plain ArrayBuffer: a Node Buffer may sit on a shared one, which a
        // request body cannot be.
        ...(body === null ? {} : { body: new Uint8Array(body) }),
      }),
    );
    if (abandoned.has(request)) return;
    if (response === undefined) {
      await route.fulfill({ status: 501, contentType: "text/plain", body: `No mock for ${label}` });
      return;
    }
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return {
    use: (...handlers) => {
      extra.unshift(...handlers);
    },
    requests,
    plans: api.plans,
    mocks,
  };
}

/** `test` with a `backend` fixture: the page's API calls are answered by the mock API. */
export const test = base.extend<{ backend: MockBackend }>({
  // The callback is named `provide`: Playwright calls it `use`, and the React hooks rule takes any
  // call of that name for the React hook of the same name.
  backend: async ({ page }, provide) => {
    await provide(await installMockApi(page));
  },
});

export { expect } from "@playwright/test";
