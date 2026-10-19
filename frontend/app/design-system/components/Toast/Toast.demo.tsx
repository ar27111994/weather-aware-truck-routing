import type { ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { StandInButton } from "../StandInButton";
import { toast, ToastRegion } from "./Toast";

/** Kitchen-sink states of {@link ToastRegion}: one trigger per toast kind, plus an action toast. */
export default function ToastDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Success (dismisses after 4 s)">
        <StandInButton onPress={() => toast.success(copy.app.copyLinkDone)}>
          Show success toast
        </StandInButton>
      </DemoState>
      <DemoState title="Error with action (stays until closed)">
        <StandInButton
          onPress={() =>
            toast.error(copy.app.copyLinkFailed, {
              action: { label: copy.error.retry, onAction: () => undefined },
            })
          }
        >
          Show error toast
        </StandInButton>
      </DemoState>
      <DemoState title="Info (dismisses after 4 s)">
        <StandInButton onPress={() => toast.info(copy.app.copyLinkDone)}>
          Show info toast
        </StandInButton>
      </DemoState>
      <ToastRegion closeLabel="Close" />
    </DemoGrid>
  );
}
