import { describe, expect, it } from "vitest";

import { fieldItems, toHeatmapLayer } from "./fields";

describe("layer switch items", () => {
  it("offers Risk, Wind, Rain and Snow, in that order", () => {
    expect(fieldItems()).toEqual([
      { id: "risk", label: "Risk" },
      { id: "wind_mph", label: "Wind" },
      { id: "rain_in_hr", label: "Rain" },
      { id: "snow_in_hr", label: "Snow" },
    ]);
  });

  it("maps an item id back to its layer and rejects anything else", () => {
    expect(toHeatmapLayer("rain_in_hr")).toBe("rain_in_hr");
    expect(() => toHeatmapLayer("gust_mph")).toThrow(RangeError);
  });
});
