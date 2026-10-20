import type { Demo } from "../../foundation/demo";
import { Divider } from "./Divider";

export const demo: Demo = {
  name: "Divider",
  description: "One-pixel hairline. Separation is made with a rule first and a shadow never.",
  states: [
    {
      id: "horizontal",
      title: "Horizontal",
      node: (
        <div style={{ inlineSize: "16rem" }}>
          <p>Above</p>
          <Divider />
          <p>Below</p>
        </div>
      ),
    },
    {
      id: "vertical",
      title: "Vertical, between inline items",
      node: (
        <div style={{ display: "inline-flex", gap: "var(--space-3)", alignItems: "center" }}>
          <span>Distance</span>
          <Divider orientation="vertical" />
          <span>Duration</span>
        </div>
      ),
    },
  ],
};
