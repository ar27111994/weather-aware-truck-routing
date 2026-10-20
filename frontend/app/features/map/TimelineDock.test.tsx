import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { minimalHeatmap } from "../../api/mocks";
import { createTripStore } from "../../state/trip-store";
import { TimelineDock } from "./TimelineDock";
import type { FrameClock } from "./usePlayback";

/** A clock that never ticks: playback state is checked without frames advancing. */
const STILL: FrameClock = { request: () => 1, cancel: () => undefined };

describe("TimelineDock", () => {
  it("waits for the forecast: a skeleton, the loading caption, and nothing to press", () => {
    render(<TimelineDock store={createTripStore()} clock={STILL} />);

    expect(screen.getByRole("status")).toHaveTextContent("Preparing 49 forecast hours");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play forecast" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Show forecast map" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Forecast time" })).toHaveAttribute(
      "data-ready",
      "false",
    );
  });

  it("drives the store's frame from the keyboard, with the time spoken in the user's locale", async () => {
    const store = createTripStore();
    render(
      <TimelineDock
        heatmap={minimalHeatmap()}
        store={store}
        clock={STILL}
        locale="en-GB"
        timeZone="America/Denver"
      />,
    );
    const slider = screen.getByRole("slider", { name: "Forecast time" });
    expect(slider).toHaveAttribute("aria-valuetext", "Tue 8:00, departure");

    act(() => {
      slider.focus();
    });
    await userEvent.keyboard("{ArrowRight}");
    expect(store.getState().sliderFrame).toBe(1);
    await userEvent.keyboard("{PageUp}");
    expect(store.getState().sliderFrame).toBe(7);
    expect(slider).toHaveAttribute("aria-valuetext", "Tue 15:00, +7 hours");
  });

  it("plays and pauses, and starts over from departure when played at the end", async () => {
    const store = createTripStore({ sliderFrame: 48 });
    render(<TimelineDock heatmap={minimalHeatmap()} store={store} clock={STILL} />);

    await userEvent.click(screen.getByRole("button", { name: "Play forecast" }));
    expect(store.getState()).toMatchObject({ playing: true, sliderFrame: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Pause forecast" }));
    expect(store.getState()).toMatchObject({ playing: false, sliderFrame: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Play forecast" }));
    expect(store.getState()).toMatchObject({ playing: true, sliderFrame: 0 });
  });

  it("switches the heatmap layer and hides the heatmap", async () => {
    const store = createTripStore();
    render(<TimelineDock heatmap={minimalHeatmap()} store={store} clock={STILL} />);

    await userEvent.click(screen.getByRole("radio", { name: "Wind" }));
    expect(store.getState().heatmapField).toBe("wind_mph");

    await userEvent.click(screen.getByRole("switch", { name: "Show forecast map" }));
    expect(store.getState().heatmapVisible).toBe(false);
  });

  it("runs on the browser's animation frames when no clock is given", () => {
    const store = createTripStore();

    render(<TimelineDock heatmap={minimalHeatmap()} store={store} />);

    expect(screen.getByRole("button", { name: "Play forecast" })).toBeEnabled();
  });
});
