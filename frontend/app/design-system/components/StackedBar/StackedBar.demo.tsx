import type { ReactElement } from "react";

import { DemoGrid, DemoState } from "../_shared/DemoState";
import { StackedBar } from "./StackedBar";

/** Kitchen-sink states of {@link StackedBar}. */
export default function StackedBarDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Low and Moderate only">
        <StackedBar
          miles={{ low: 480.1, moderate: 32.3, high: 0, severe: 0, no_travel: 0, unknown: 0 }}
        />
      </DemoState>
      <DemoState title="Every level, with Unknown">
        <StackedBar
          miles={{
            low: 310,
            moderate: 120.5,
            high: 48.2,
            severe: 22.9,
            no_travel: 4.3,
            unknown: 6.5,
          }}
        />
      </DemoState>
      <DemoState title="A sliver at minimum width">
        <StackedBar
          miles={{ low: 600, moderate: 0, high: 0, severe: 0, no_travel: 0.2, unknown: 0 }}
        />
      </DemoState>
    </DemoGrid>
  );
}
