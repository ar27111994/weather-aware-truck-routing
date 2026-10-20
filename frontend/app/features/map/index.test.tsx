import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import { installMatchMedia } from "../../../test/match-media";
import { minimalPlan } from "../../api/mocks";
import { createTripStore } from "../../state/trip-store";
import { MapView } from "./index";

vi.mock("maplibre-gl", () => import("../../../test/fake-maplibre"));

class InertResizeObserver {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

describe("the map feature's entry", () => {
  it("loads MapView (and MapLibre with it) only when it first renders", async () => {
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
    installMatchMedia();
    render(
      <Suspense fallback={<p>Loading map</p>}>
        <MapView plan={minimalPlan()} theme="light" store={createTripStore()} />
      </Suspense>,
    );

    expect(screen.getByText("Loading map")).toBeInTheDocument();
    expect(await screen.findByTestId("map-canvas-container")).toBeInTheDocument();
  });
});
