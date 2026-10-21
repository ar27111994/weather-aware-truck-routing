import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { minimalHeatmap } from "../../api/mocks";
import { createTripStore } from "../../state/trip-store";
import { TimelineDock } from "./TimelineDock";
import type { FrameClock } from "./usePlayback";

/**
 * R7: scrubbing re-renders the readout and the slider, nothing else. Every design-system control
 * of the dock is wrapped in a counter, so a frame change that re-rendered one of them would show.
 */
const renders = vi.hoisted(() => ({ play: 0, field: 0, heatmapSwitch: 0 }));

vi.mock("../../design-system/components/IconButton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../design-system/components/IconButton")>();
  return {
    ...actual,
    IconButton: (props: Parameters<typeof actual.IconButton>[0]): ReactElement => {
      renders.play += 1;
      return createElement(actual.IconButton, props);
    },
  };
});

vi.mock("../../design-system/components/Segmented", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../design-system/components/Segmented")>();
  return {
    ...actual,
    Segmented: (props: Parameters<typeof actual.Segmented>[0]): ReactElement => {
      renders.field += 1;
      return createElement(actual.Segmented, props);
    },
  };
});

vi.mock("../../design-system/components/Switch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../design-system/components/Switch")>();
  return {
    ...actual,
    Switch: (props: Parameters<typeof actual.Switch>[0]): ReactElement => {
      renders.heatmapSwitch += 1;
      return createElement(actual.Switch, props);
    },
  };
});

/** A clock that never ticks. */
const STILL: FrameClock = { request: () => 1, cancel: () => undefined };

describe("TimelineDock re-renders", () => {
  it("moves the frame without re-rendering Play, the layer menu or the heatmap switch", () => {
    const store = createTripStore();
    render(<TimelineDock heatmap={minimalHeatmap()} store={store} clock={STILL} />);
    const before = { ...renders };

    act(() => {
      store.actions.setFrame(5);
    });
    act(() => {
      store.actions.stepFrame(1);
    });

    expect(screen.getByRole("slider", { name: "Forecast time" })).toHaveValue("6");
    expect(renders).toEqual(before);
  });

  it("re-renders Play when playback starts, and the layer controls when the layer changes", () => {
    const store = createTripStore();
    render(<TimelineDock heatmap={minimalHeatmap()} store={store} clock={STILL} />);
    const before = { ...renders };

    act(() => {
      store.actions.toggle();
    });
    expect(renders.play).toBeGreaterThan(before.play);
    expect(screen.getByRole("button", { name: "Pause forecast" })).toBeInTheDocument();

    act(() => {
      store.actions.setField("wind_mph");
    });
    expect(renders.field).toBeGreaterThan(before.field);
    expect(screen.getByRole("radio", { name: "Wind" })).toBeChecked();
  });
});
