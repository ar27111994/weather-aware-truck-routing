import { describe, expect, it } from "vitest";

import contract from "./__fixtures__/design-contract.microcopy.json";
import microcopy from "./microcopy.json";

// `.planning/design/microcopy.json` is the one source of the product's words (D-27). The file the
// app imports is a copy of it, and the fixture is a verbatim snapshot of the source, taken when the
// copy was made (the way `tokens/__fixtures__` snapshots the design tokens). A word changed in the
// copy alone, or in the source alone, fails here, so the two cannot drift apart unnoticed. To change
// a string: edit the source, then copy it over both this fixture and `microcopy.json`.
describe("microcopy.json and the design contract", () => {
  it("is the design contract's file, word for word", () => {
    expect(microcopy).toEqual(contract);
  });

  it("carries the chrome of the style guide the design contract names", () => {
    expect(Object.keys(contract)).toContain("design");
    expect(Object.keys(microcopy)).toContain("design");
  });
});
