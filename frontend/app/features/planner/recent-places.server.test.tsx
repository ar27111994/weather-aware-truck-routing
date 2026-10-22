// @vitest-environment node
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useRecentPlaces } from "./recent-places";

function Probe(): ReactElement {
  return <span>{useRecentPlaces().places.length}</span>;
}

describe("useRecentPlaces on the server", () => {
  it("lists no places: storage belongs to the browser, and the prerendered page has none to show", () => {
    expect(renderToString(<Probe />)).toBe("<span>0</span>");
  });
});
