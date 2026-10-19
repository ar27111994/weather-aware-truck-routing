import { useState, type ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { StandInButton } from "../StandInButton";
import { Dialog, DialogTrigger } from "./Dialog";

/** Kitchen-sink state of {@link Dialog}: the "Clear recent searches?" confirmation. */
export default function DialogDemo(): ReactElement {
  const [cleared, setCleared] = useState(0);
  return (
    <DemoGrid>
      <DemoState title="Confirmation">
        <DialogTrigger>
          <StandInButton>{copy.search.clearRecent}</StandInButton>
          <Dialog
            title={copy.search.clearRecentConfirmTitle}
            closeLabel="Close"
            actions={
              <>
                <StandInButton slot="close">{copy.search.cancel}</StandInButton>
                <StandInButton
                  slot="close"
                  variant="primary"
                  onPress={() => {
                    setCleared((count) => count + 1);
                  }}
                >
                  {copy.search.clearRecentConfirm}
                </StandInButton>
              </>
            }
          >
            <p>{copy.search.clearRecentConfirmBody}</p>
          </Dialog>
        </DialogTrigger>
        <p>{`Cleared ${String(cleared)} time${cleared === 1 ? "" : "s"}`}</p>
      </DemoState>
    </DemoGrid>
  );
}
