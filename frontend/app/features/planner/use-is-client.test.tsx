import { renderHook } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useIsClient } from "./use-is-client";

function Probe(): ReactElement {
  return <span>{String(useIsClient())}</span>;
}

describe("useIsClient", () => {
  it("is false when the page is rendered on the server (the prerender)", () => {
    expect(renderToString(<Probe />)).toBe("<span>false</span>");
  });

  it("is true in the browser", () => {
    const { result } = renderHook(() => useIsClient());

    expect(result.current).toBe(true);
  });
});
