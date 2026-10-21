import { describe, expect, it } from "vitest";

import routes from "./routes";

describe("route config", () => {
  it("has the prerendered pages, the client-rendered kitchen sink and a catch-all, in that order", () => {
    expect(routes).toEqual([
      expect.objectContaining({ index: true, file: "routes/home.tsx" }),
      expect.objectContaining({ path: "methodology", file: "routes/methodology.tsx" }),
      expect.objectContaining({ path: "design", file: "routes/design.tsx" }),
      expect.objectContaining({ path: "design/map", file: "routes/design-map.tsx" }),
      expect.objectContaining({ path: "*", file: "routes/not-found.tsx" }),
    ]);
  });
});
