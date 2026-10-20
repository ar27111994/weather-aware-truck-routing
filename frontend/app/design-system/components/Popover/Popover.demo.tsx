import type { CSSProperties, ReactElement } from "react";

import { cx } from "../../foundation/cx";
import type { Demo } from "../../foundation/demo";
import { Button } from "../Button";
import { Popover } from "./Popover";
import styles from "./Popover.module.css";

function Body(): ReactElement {
  return (
    <>
      <p style={{ margin: 0, fontWeight: 700 }}>Checkpoint 7, 175 miles</p>
      <p style={{ margin: "var(--space-1) 0 0" }}>Moderate. Wind 31 mph, gusts 38 mph.</p>
    </>
  );
}

/** The 12 px between trigger and panel (DESIGN.md section 10, Popover). */
const GAP = "12px";

/** Height kept free beside the trigger for the drawn panel, which takes no room in the flow. */
const PANEL_ROOM = "136px";

/**
 * A popover drawn open, in place. A real non-modal popover closes the moment the page scrolls, and
 * a modal one would lock the page, so neither can stay open on a long kitchen sink; this specimen
 * reuses the component's own styles and stays where it is drawn.
 */
function Specimen({
  placement,
  width,
}: {
  readonly placement: "top" | "bottom";
  readonly width: "content" | "checkpoint";
}): ReactElement {
  const below = placement === "bottom";
  const stage: CSSProperties = {
    display: "grid",
    justifyItems: "center",
    inlineSize: "min(100%, 340px)",
    paddingBlock: below ? `0 ${PANEL_ROOM}` : `${PANEL_ROOM} 0`,
  };
  const panel: CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    ...(below ? { top: `calc(100% + ${GAP})` } : { bottom: `calc(100% + ${GAP})` }),
    ...(width === "content" ? { inlineSize: "max-content" } : {}),
  };
  const arrow: CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    ...(below ? { bottom: "100%" } : { top: "100%" }),
  };
  return (
    <span style={stage}>
      <span style={{ position: "relative", display: "inline-block" }}>
        <Button>Checkpoint 7</Button>
        <span
          className={cx(styles["popover"])}
          data-placement={placement}
          data-width={width}
          style={panel}
        >
          <span className={cx(styles["arrow"])} style={arrow}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M0 0 L6 6 L12 0" />
            </svg>
          </span>
          <span className={cx(styles["dialog"])} style={{ display: "block" }}>
            <Body />
          </span>
        </span>
      </span>
    </span>
  );
}

export const demo: Demo = {
  name: "Popover",
  description:
    "Raised, non-modal panel anchored to a trigger. Escape or an outside press closes it and focus returns to the trigger.",
  states: [
    {
      id: "open-bottom",
      title: "Open, below the trigger",
      node: <Specimen placement="bottom" width="content" />,
    },
    {
      id: "open-top",
      title: "Open, above the trigger, checkpoint width",
      node: <Specimen placement="top" width="checkpoint" />,
    },
    {
      id: "closed",
      title: "Closed: press the trigger",
      node: (
        <Popover label="Legend" trigger={<Button>Legend</Button>}>
          <Body />
        </Popover>
      ),
    },
  ],
};
