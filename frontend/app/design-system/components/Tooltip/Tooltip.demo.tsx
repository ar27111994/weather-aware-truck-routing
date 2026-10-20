import type { CSSProperties, ReactElement } from "react";

import type { Demo } from "../../foundation/demo";
import { cx } from "../../foundation/cx";
import { Button } from "../Button";
import { Tooltip } from "./Tooltip";
import type { TooltipPlacement } from "./Tooltip";
import styles from "./Tooltip.module.css";

const ROOM = {
  position: "relative",
  display: "inline-block",
  margin: "var(--space-12) var(--space-16)",
} as const;

/** The 8 px between trigger and tooltip (DESIGN.md section 10, Tooltip). */
const GAP = "8px";

/** Where the bubble and its arrow sit around the trigger, for each side. */
const GEOMETRY: Readonly<
  Record<TooltipPlacement, { readonly bubble: CSSProperties; readonly arrow: CSSProperties }>
> = {
  top: {
    bubble: { bottom: `calc(100% + ${GAP})`, left: "50%", transform: "translateX(-50%)" },
    arrow: { top: "100%", left: "50%", transform: "translateX(-50%)" },
  },
  bottom: {
    bubble: { top: `calc(100% + ${GAP})`, left: "50%", transform: "translateX(-50%)" },
    arrow: { bottom: "100%", left: "50%", transform: "translateX(-50%)" },
  },
  left: {
    bubble: { right: `calc(100% + ${GAP})`, top: "50%", transform: "translateY(-50%)" },
    arrow: { left: "100%", top: "50%", transform: "translateY(-50%)" },
  },
  right: {
    bubble: { left: `calc(100% + ${GAP})`, top: "50%", transform: "translateY(-50%)" },
    arrow: { right: "100%", top: "50%", transform: "translateY(-50%)" },
  },
};

/**
 * A tooltip drawn open, in place. A real open tooltip closes the moment the page scrolls and is
 * placed against the visible viewport, so on a long page it would drift away from its trigger and
 * vanish; this specimen reuses the component's own styles and stays where it is drawn.
 */
function Specimen({
  placement,
  label,
}: {
  readonly placement: TooltipPlacement;
  readonly label: string;
}): ReactElement {
  const { bubble, arrow } = GEOMETRY[placement];
  return (
    <span style={ROOM}>
      <Button>{label}</Button>
      <span
        className={cx(styles["tooltip"])}
        data-placement={placement}
        style={{ position: "absolute", whiteSpace: "nowrap", ...bubble }}
      >
        <span className={cx(styles["arrow"])} style={{ position: "absolute", ...arrow }}>
          <svg viewBox="0 0 8 8" aria-hidden="true">
            <path d="M0 0 L4 4 L8 0" />
          </svg>
        </span>
        {label}
      </span>
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
