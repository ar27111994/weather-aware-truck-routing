// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const NODE_ONLY = "msw/node was loaded";

/** The messages of an error and of every cause below it (Vitest wraps a throwing mock factory). */
function messages(error: unknown): string[] {
  return error instanceof Error ? [error.message, ...messages(error.cause)] : [];
}

/**
 * `msw/node` imports Node built-ins, so a browser bundle that reaches it breaks. Making its module
 * throw on load turns "was it loaded?" into a plain assertion about what an import pulls in. It
 * sees load-time imports only: a lazy `import("msw/node")` inside the barrel would still be
 * bundled by Vite, so keep `msw/node` out of every module but `node.ts`.
 */
function forbidMswNode(): void {
  vi.resetModules();
  vi.doMock("msw/node", () => {
    throw new Error(NODE_ONLY);
  });
}

afterEach(() => {
  vi.doUnmock("msw/node");
  vi.resetModules();
});

// Each test re-imports the real mocks module graph (route data, builders, msw), which takes seconds
// under coverage instrumentation, so the default 5 s test timeout is too tight.
const IMPORT_TIMEOUT_MS = 30_000;

describe(
  "the mocks barrel (what a browser dev-mock bootstrap imports)",
  { timeout: IMPORT_TIMEOUT_MS },
  () => {
    it("never loads msw/node", async () => {
      forbidMswNode();

      const barrel = await import("./index");

      expect(barrel.createMockApi().handlers.length).toBeGreaterThan(0);
    });

    it("does not export the Node-only server", async () => {
      const barrel = await import("./index");

      expect(barrel).not.toHaveProperty("createMockServer");
    });
  },
);

describe("the Node entry", { timeout: IMPORT_TIMEOUT_MS }, () => {
  it("is the one place msw/node is loaded (so the barrel check above can fail)", async () => {
    forbidMswNode();

    const error = await import("./node").catch((caught: unknown) => caught);

    expect(messages(error)).toContain(NODE_ONLY);
  });

  it("serves the same handlers the barrel builds", async () => {
    const { createMockServer } = await import("./node");
    const { createMockApi } = await import("./index");

    const api = createMockApi();
    const server = createMockServer(api);

    expect(server.listHandlers()).toHaveLength(api.handlers.length);
    expect(createMockServer().listHandlers().length).toBeGreaterThan(0);
  });
});
