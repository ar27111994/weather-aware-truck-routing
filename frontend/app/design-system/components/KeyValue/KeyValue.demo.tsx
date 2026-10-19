import type { ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { KeyValue } from "./KeyValue";

const tripDetails = [
  { label: copy.route.distance, value: "512.4 mi" },
  { label: copy.route.duration, value: "7 h 44 min" },
  { label: copy.route.avgRisk, value: "0.38" },
];

/** Kitchen-sink states of {@link KeyValue}. */
export default function KeyValueDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Stacked">
        <KeyValue entries={tripDetails} />
      </DemoState>
      <DemoState title="Inline">
        <KeyValue entries={tripDetails} layout="inline" />
      </DemoState>
    </DemoGrid>
  );
}
