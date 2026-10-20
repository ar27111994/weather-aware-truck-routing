import type { Demo } from "../../foundation/demo";
import { StackedBar } from "./StackedBar";

/** What the `/design` route renders for StackedBar: three routes' worth of miles by level. */
export const demo: Demo = {
  name: "StackedBar",
  description: "Miles by risk level as a proportional bar with patterns and text values.",
  states: [
    {
      id: "low-moderate",
      title: "Low and Moderate only",
      node: (
        <StackedBar
          miles={{ low: 480.1, moderate: 32.3, high: 0, severe: 0, no_travel: 0, unknown: 0 }}
        />
      ),
    },
    {
      id: "every-level",
      title: "Every level, with Unknown",
      node: (
        <StackedBar
          miles={{
            low: 310,
            moderate: 120.5,
            high: 48.2,
            severe: 22.9,
            no_travel: 4.3,
            unknown: 6.5,
          }}
        />
      ),
    },
    {
      id: "sliver",
      title: "A sliver at minimum width",
      node: (
        <StackedBar
          miles={{ low: 600, moderate: 0, high: 0, severe: 0, no_travel: 0.2, unknown: 0 }}
        />
      ),
    },
  ],
};
