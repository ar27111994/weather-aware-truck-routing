import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeUpperEdge, moveUpperEdge, validRules } from "../../../test/risk-rules-variants";
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

  it("says in its footnote where a value on an edge goes, in the words of today's rules (RT-F2)", () => {
    render(<MapLegend store={createTripStore()} />);

    expect(
      screen.getByText(
        "A value on a boundary belongs to the higher band, except rain at exactly 1.00 and snow at " +
          "exactly 3.0 in/hr, which stay Severe.",
      ),
    ).toBeInTheDocument();
  });

  it("draws its wind ramp from the rules it is given (RT-F2)", () => {
    const rules = validRules((copy) => {
      moveUpperEdge(copy, "wind", "low", 30);
      copy.factors.wind.unit = "km/h";
    });

    render(<MapLegend store={createTripStore({ heatmapField: "wind_mph" })} rules={rules} />);

    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.queryByText("25")).not.toBeInTheDocument();
    expect(screen.getByText("km/h")).toBeInTheDocument();
    expect(screen.queryByText("mph")).not.toBeInTheDocument();
  });

  it("says in the words of its ramp, for screen readers, what each step is in the rules it is given (RT-F4)", () => {
    const rules = validRules((copy) => {
      moveUpperEdge(copy, "wind", "low", 30);
      copy.factors.wind.unit = "km/h";
    });

    render(<MapLegend store={createTripStore({ heatmapField: "wind_mph" })} rules={rules} />);

    for (const words of [
      "under 30 km/h",
      "30 to under 35",
      "35 to under 45",
      "45 to under 55",
      "55 km/h or more",
    ]) {
      expect(screen.getByText(words)).toBeInTheDocument();
    }
    expect(screen.queryByText("under 25 mph")).not.toBeInTheDocument();
  });

  it("writes its footnote from the rules it is given (RT-F2)", () => {
    const rules = validRules((copy) => {
      closeUpperEdge(copy, "wind", "high");
    });

    render(<MapLegend store={createTripStore()} rules={rules} />);

    expect(
      screen.getByText(
        "A value on a boundary belongs to the higher band, except wind at exactly 45 mph, which stays " +
          "High, and rain at exactly 1.00 and snow at exactly 3.0 in/hr, which stay Severe.",
      ),
    ).toBeInTheDocument();
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
