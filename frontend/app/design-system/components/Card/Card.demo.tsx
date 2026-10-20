import type { Demo } from "../../foundation/demo";
import { Card } from "./Card";

export const demo: Demo = {
  name: "Card",
  description:
    "Raised surface with a hairline border and no shadow. Selection is a 2 px inset border, so nothing shifts.",
  states: [
    { id: "default", title: "Default", node: <Card>Route A. 512.4 mi, 7 h 44 min</Card> },
    {
      id: "selected",
      title: "Selected",
      node: <Card isSelected>Route B. 498.0 mi, 7 h 30 min</Card>,
    },
  ],
};
