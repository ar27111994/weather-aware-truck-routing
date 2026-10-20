import type { ReactElement } from "react";

import type { Demo } from "../../foundation/demo";
import { Button } from "../Button";
import { Tooltip } from "./Tooltip";

const ROOM = { display: "inline-block", padding: "var(--space-12) var(--space-16)" } as const;

function Specimen({
  placement,
  label,
}: {
  readonly placement: "top" | "bottom" | "left" | "right";
  readonly label: string;
}): ReactElement {
  return (
    <span style={ROOM}>
      <Tooltip content={label} placement={placement} defaultOpen>
        <Button>{label}</Button>
      </Tooltip>
    </span>
  );
}

export const demo: Demo = {
  name: "Tooltip",
  description:
    "Ink label for an icon-only or truncated control. Opens after 400 ms of hover, at once on keyboard focus, closes on Escape. It never holds essential information.",
  states: [
    {
      id: "top",
      title: "Top (default), pinned open",
      node: <Specimen placement="top" label="Copy link" />,
    },
    {
      id: "bottom",
      title: "Bottom, pinned open",
      node: <Specimen placement="bottom" label="Zoom in" />,
    },
    {
      id: "left",
      title: "Left, pinned open",
      node: <Specimen placement="left" label="Fit routes" />,
    },
    {
      id: "right",
      title: "Right, pinned open",
      node: <Specimen placement="right" label="Zoom out" />,
    },
    {
      id: "closed",
      title: "Closed: hover for 400 ms or focus with the keyboard",
      node: (
        <Tooltip content="Swap origin and destination">
          <Button>Swap</Button>
        </Tooltip>
      ),
    },
    {
      id: "disabled",
      title: "Disabled: never opens",
      node: (
        <Tooltip content="Never shown" isDisabled>
          <Button>No tooltip</Button>
        </Tooltip>
      ),
    },
  ],
};
