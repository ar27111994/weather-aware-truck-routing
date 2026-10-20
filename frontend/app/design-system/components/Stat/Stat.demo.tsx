import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { DemoGrid, DemoState } from "../_shared/DemoState";
import { Stat } from "./Stat";

/** Kitchen-sink states of {@link Stat}. */
function StatDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Value only">
        <Stat label="Checkpoints" value="26" />
      </DemoState>
      <DemoState title="With unit">
        <Stat label="Distance" value="512.4" unit="mi" />
      </DemoState>
      <DemoState title="With unit and delta">
        <Stat label="Drive time" value="7 h 44" unit="min" delta="12 min longer than Route A" />
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for Stat: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "Stat",
  description: "One headline number with a label, a unit and an optional delta.",
  states: [{ id: "states", title: "States", node: <StatDemo /> }],
};
