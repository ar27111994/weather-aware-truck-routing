import { http, HttpResponse } from "msw/http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  closeConnections,
  keepsSocketAlive,
  watchKeepAlive,
} from "../../../test/close-connections";
import { createMockServer } from "./node";

// This file has its own server and does not call `startMockApi()`: several tests send a request
// that keeps its socket alive on purpose, and the guard that `startMockApi()` installs would fail
// them. Every test also talks to an origin of its own, so no request here can reuse a socket,
// which is the thing mswjs/interceptors#862 is about.
const server = createMockServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

interface Echo {
  method: string;
  connection: string | null;
  probe: string | null;
  body: string;
}

/** Answers `POST <origin>/echo` and returns what the server saw of the request. */
function echoAt(origin: string): () => Echo | undefined {
  let seen: Echo | undefined;
  server.use(
    http.post(`${origin}/echo`, async ({ request }) => {
      seen = {
        method: request.method,
        connection: request.headers.get("connection"),
        probe: request.headers.get("x-probe"),
        body: await request.text(),
      };
      return HttpResponse.json({});
    }),
  );
  return () => seen;
}

describe("closeConnections", () => {
  it("adds Connection: close to a request given as a URL and init, and keeps the rest", async () => {
    const origin = "http://as-url.test";
    const seen = echoAt(origin);

    const response = await closeConnections(`${origin}/echo`, {
      method: "POST",
      headers: { "x-probe": "kept" },
      body: "payload",
    });

    expect(response.status).toBe(200);
    expect(seen()).toEqual({
      method: "POST",
      connection: "close",
      probe: "kept",
      body: "payload",
    });
  });

  it("adds Connection: close to a Request object, and keeps the rest", async () => {
    const origin = "http://as-request.test";
    const seen = echoAt(origin);

    await closeConnections(
      new Request(`${origin}/echo`, {
        method: "POST",
        headers: { "x-probe": "kept" },
        body: "payload",
      }),
    );

    expect(seen()).toEqual({
      method: "POST",
      connection: "close",
      probe: "kept",
      body: "payload",
    });
  });
});

describe("keepsSocketAlive", () => {
  it.each([
    ["keep-alive", true],
    ["close", false],
    ["Close", false],
    [null, true],
  ])(
    "says that a request with connection %j keeps its socket alive: %s",
    (connection, expected) => {
      const headers = connection === null ? {} : { connection };

      expect(keepsSocketAlive(new Request("http://headers.test/", { headers }))).toBe(expected);
    },
  );
});

describe("watchKeepAlive", () => {
  it("names the request and the upstream issue when a request keeps its socket alive", async () => {
    const origin = "http://kept.test";
    server.use(http.get(`${origin}/ping`, () => HttpResponse.text("pong")));
    const watch = watchKeepAlive(server);

    await fetch(`${origin}/ping`);

    expect(() => {
      watch.check();
    }).toThrow(/GET http:\/\/kept\.test\/ping \(connection: keep-alive\)/);
  });

  it("reports a request once: the check drains what it found", async () => {
    const origin = "http://drained.test";
    server.use(http.get(`${origin}/ping`, () => HttpResponse.text("pong")));
    const watch = watchKeepAlive(server);

    await fetch(`${origin}/ping`);
    expect(() => {
      watch.check();
    }).toThrow(/drained\.test/);

    expect(() => {
      watch.check();
    }).not.toThrow();
  });

  it("links to the upstream issue and names the cure in the message", async () => {
    const origin = "http://linked.test";
    server.use(http.get(`${origin}/ping`, () => HttpResponse.text("pong")));
    const watch = watchKeepAlive(server);

    await fetch(`${origin}/ping`);

    expect(() => {
      watch.check();
    }).toThrow(/https:\/\/github\.com\/mswjs\/interceptors\/issues\/862[\s\S]*closeConnections/);
  });

  it("stays quiet for requests that close their connection", async () => {
    const origin = "http://closed.test";
    server.use(http.get(`${origin}/ping`, () => HttpResponse.text("pong")));
    const watch = watchKeepAlive(server);

    await closeConnections(`${origin}/ping`);

    expect(() => {
      watch.check();
    }).not.toThrow();
  });

  it("lists every request that kept its socket alive since the last check", async () => {
    server.use(
      http.get("http://first.test/a", () => HttpResponse.text("a")),
      http.get("http://second.test/b", () => HttpResponse.text("b")),
    );
    const watch = watchKeepAlive(server);

    await fetch("http://first.test/a");
    await fetch("http://second.test/b");

    expect(() => {
      watch.check();
    }).toThrow(/2 requests[\s\S]*first\.test\/a[\s\S]*second\.test\/b/);
  });
});
