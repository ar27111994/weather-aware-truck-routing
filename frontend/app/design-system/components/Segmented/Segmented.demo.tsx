import { CloudRain, Snowflake, TriangleAlert, Wind } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { Segmented } from "./Segmented";

const INTERVALS = [
  { id: "10", label: "10 mi" },
  { id: "25", label: "25 mi" },
  { id: "50", label: "50 mi" },
] as const;

const LAYERS = [
  { id: "risk", label: "Risk", icon: TriangleAlert },
  { id: "wind", label: "Wind", icon: Wind },
  { id: "rain", label: "Rain", icon: CloudRain },
  { id: "snow", label: "Snow", icon: Snowflake },
] as const;

export const demo: Demo = {
  name: "Segmented",
  description:
    "Single choice on a sunken track. One item is always selected, items share the width, selected is ink.",
  states: [
    {
      id: "interval",
      title: "Checkpoint interval, 25 mi selected",
      node: <Segmented label="Weather check every" items={INTERVALS} defaultValue="25" />,
    },
    {
      id: "layers",
      title: "With icons",
      node: <Segmented label="Map layer" items={LAYERS} defaultValue="wind" />,
    },
    {
      id: "disabled-item",
      title: "One item disabled",
      node: (
        <Segmented
          label="Map layer"
          items={[
            { id: "risk", label: "Risk" },
            { id: "wind", label: "Wind" },
            { id: "rain", label: "Rain", isDisabled: true },
          ]}
          defaultValue="risk"
        />
      ),
    },
    {
      id: "disabled",
      title: "Disabled",
      node: (
        <Segmented label="Weather check every" items={INTERVALS} defaultValue="10" isDisabled />
      ),
    },
  ],
};
