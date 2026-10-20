import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { KeyValue } from "./KeyValue";

const tripDetails = [
  { label: t("route.distance"), value: "512.4 mi" },
  { label: t("route.duration"), value: "7 h 44 min" },
  { label: t("route.avgRisk"), value: "0.38" },
];

/** Kitchen-sink states of {@link KeyValue}. */
function KeyValueDemo(): ReactElement {
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

/** What the `/design` route renders for KeyValue: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "KeyValue",
  description: "Label and value pairs as a description list.",
  states: [{ id: "states", title: "States", node: <KeyValueDemo /> }],
};
