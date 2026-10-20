import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { DemoGrid, DemoState } from "../_shared/DemoState";
import { TextField } from "./TextField";

/** Kitchen-sink states of {@link TextField}. */
function TextFieldDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Default">
        <TextField label="Plan name" placeholder="Example: Denver run" />
      </DemoState>
      <DemoState title="With hint">
        <TextField
          label="Reference"
          description="Printed on the shared link."
          defaultValue="DEN-0420"
        />
      </DemoState>
      <DemoState title="Invalid">
        <TextField
          label="Plan name"
          defaultValue="x"
          isInvalid
          errorMessage="Use at least 3 characters."
        />
      </DemoState>
      <DemoState title="Disabled">
        <TextField label="Plan name" defaultValue="Locked while planning" isDisabled />
      </DemoState>
      <DemoState title="Read only">
        <TextField label="Plan ID" defaultValue="hc_7Kq2" isReadOnly />
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for TextField: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "TextField",
  description: "Single-line text input with label, hint and error.",
  states: [{ id: "states", title: "States", node: <TextFieldDemo /> }],
};
