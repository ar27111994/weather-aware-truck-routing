// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const NODE_ONLY = "msw/node was loaded";

/** The messages of an error and of every cause below it (Vitest wraps a throwing mock factory). */
function messages(error: unknown): string[] {
  return error instanceof Error ? [error.message, ...messages(error.cause)] : [];
}

/**
 * `msw/node` imports Node built-ins, so a browser bundle that reaches it breaks. Making its module
 * throw on load turns "was it loaded?" into a plain assertion about what an import pulls in.
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

describe("the mocks barrel (what the browser bootstrap imports)", () => {
  it("never loads msw/node", async () => {
    forbidMswNode();

    const barrel = await import("./index");

    expect(barrel.createMockApi().handlers.length).toBeGreaterThan(0);
  });

  it("does not export the Node-only server", async () => {
    const barrel = await import("./index");

    expect(barrel).not.toHaveProperty("createMockServer");
  });
});

describe("the Node entry", () => {
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
