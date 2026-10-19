import { describe, expect, it } from "vitest";

import routes from "./routes";

describe("route config", () => {
  it("prerendered pages are the home index and /methodology, each backed by its own module", () => {
    expect(routes).toEqual([
      expect.objectContaining({ index: true, file: "routes/home.tsx" }),
      expect.objectContaining({ path: "methodology", file: "routes/methodology.tsx" }),
    ]);
  });
});
