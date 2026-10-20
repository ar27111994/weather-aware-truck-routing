import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTripStore } from "../../state/trip-store";
import { MapLegend } from "./MapLegend";

describe("MapLegend (DESIGN.md section 9.9)", () => {
  it("lists the six risk rows with Unknown explained, for the risk layer", () => {
    render(<MapLegend store={createTripStore()} />);

    expect(screen.getByRole("group", { name: "Risk level" })).toBeInTheDocument();
    for (const word of ["Low", "Moderate", "High", "Severe", "No Travel", "Unknown"]) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
    expect(screen.getByText("Missing weather data")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Legend" })).toBeInTheDocument();
  });

  it("follows the layer switch: a wind ramp in mph with its floor note and the grey Unknown", () => {
    const store = createTripStore();
    render(<MapLegend store={store} headingLevel={3} />);

    act(() => {
      store.actions.setField("wind_mph");
    });

    expect(screen.getByRole("group", { name: "Wind speed, mph" })).toBeInTheDocument();
    expect(screen.getByText("Not shaded: under 15 mph")).toBeInTheDocument();
    expect(screen.getByText("55")).toBeInTheDocument();
    expect(screen.getByText("under 25 mph")).toBeInTheDocument();
    expect(screen.getByText("Missing weather data")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Legend" })).toBeInTheDocument();
  });

  it("uses the precipitation floor for rain and snow", () => {
    render(<MapLegend store={createTripStore({ heatmapField: "snow_in_hr" })} className="extra" />);

    expect(screen.getByRole("group", { name: "Snow, in/hr" })).toBeInTheDocument();
    expect(screen.getByText("Not shaded: under 0.01 in/hr")).toBeInTheDocument();
    expect(screen.getByText("3.0")).toBeInTheDocument();
  });
});
