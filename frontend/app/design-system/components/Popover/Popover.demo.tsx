import type { ReactElement } from "react";

import type { Demo } from "../../foundation/demo";
import { Button } from "../Button";
import { Popover } from "./Popover";

function Body(): ReactElement {
  return (
    <>
      <p style={{ margin: 0, fontWeight: 700 }}>Checkpoint 7, 175 miles</p>
      <p style={{ margin: "var(--space-1) 0 0" }}>Moderate. Wind 31 mph, gusts 38 mph.</p>
    </>
  );
}

const ROOM = { display: "inline-block", padding: "var(--space-16) var(--space-20)" } as const;

export const demo: Demo = {
  name: "Popover",
  description:
    "Raised, non-modal panel anchored to a trigger. Escape or an outside press closes it and focus returns to the trigger.",
  states: [
    {
      id: "open-bottom",
      title: "Open, below the trigger (pinned open)",
      node: (
        <span style={ROOM}>
          <Popover
            label="Checkpoint 7"
            trigger={<Button>Checkpoint 7</Button>}
            defaultOpen
            isNonModal
          >
            <Body />
          </Popover>
        </span>
      ),
    },
    {
      id: "open-top",
      title: "Open, above the trigger, checkpoint width",
      node: (
        <span style={ROOM}>
          <Popover
            label="Checkpoint 7"
            trigger={<Button>Checkpoint 7</Button>}
            placement="top"
            width="checkpoint"
            defaultOpen
            isNonModal
          >
            <Body />
          </Popover>
        </span>
      ),
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
