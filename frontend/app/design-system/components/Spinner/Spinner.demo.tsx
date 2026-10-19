import type { Demo } from "../../foundation/demo";
import { Spinner } from "./Spinner";

export const demo: Demo = {
  name: "Spinner",
  description:
    "Indeterminate progress for one control or one list. Rotates for 900 ms linear, static when motion is reduced.",
  states: [
    {
      id: "icon-only",
      title: "16 px, label for screen readers only",
      node: <Spinner label="Searching" />,
    },
    { id: "large", title: "20 px", node: <Spinner label="Loading map" size={20} /> },
    {
      id: "with-label",
      title: "With visible label",
      node: <Spinner label="Planning routes" showLabel />,
    },
  ],
};
