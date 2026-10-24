import { http } from "msw/http";
import { describe, expect, it } from "vitest";

import { API_BASE, startMockApi } from "../../../test/api";

const { server, client } = startMockApi();

/** The `Connection` header of every request that reaches the mock server while `send` runs. */
async function connectionsSeenWhile(send: () => Promise<unknown>): Promise<(string | null)[]> {
  const seen: (string | null)[] = [];
  // A resolver that returns nothing hands the request to the next handler, so the default mock
  // backend still answers it.
  server.use(
    http.all(`${API_BASE}/*`, ({ request }) => {
      seen.push(request.headers.get("connection"));
    }),
  );
  await send();
  return seen;
}

describe("the connection policy of the mock API (mswjs/interceptors#862)", () => {
  it("asks for a fresh socket on every request that the test client sends", async () => {
    const seen = await connectionsSeenWhile(async () => {
      await client.geocode("den");
      await client.getRules();
    });

    expect(seen).toEqual(["close", "close"]);
  });
});
