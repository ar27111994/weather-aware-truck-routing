import type { Demo } from "../../foundation/demo";
import { Skeleton } from "./Skeleton";

export const demo: Demo = {
  name: "Skeleton",
  description:
    "Flat sunken placeholders that mirror the final layout. The opacity pulses, and holds still when reduced motion is on.",
  states: [
    {
      id: "route-card",
      title: "Route card rows",
      node: (
        <div
          aria-busy="true"
          style={{ display: "grid", gap: "var(--space-3)", inlineSize: "20rem" }}
        >
          <Skeleton height="title" width="half" />
          <Skeleton lines={2} />
          <Skeleton height="bar" />
        </div>
      ),
    },
    {
      id: "text-lines",
      title: "Three lines of text",
      node: (
        <div style={{ inlineSize: "20rem" }}>
          <Skeleton lines={3} />
        </div>
      ),
    },
    {
      id: "plate",
      title: "Circle (plate or marker)",
      node: (
        <div style={{ inlineSize: "3rem" }}>
          <Skeleton shape="circle" height="block" />
        </div>
      ),
    },
    {
      id: "widths",
      title: "Widths: quarter, third, half, three quarters",
      node: (
        <div style={{ display: "grid", gap: "var(--space-2)", inlineSize: "20rem" }}>
          <Skeleton width="quarter" />
          <Skeleton width="third" />
          <Skeleton width="half" />
          <Skeleton width="three-quarters" />
        </div>
      ),
    },
  ],
};
