import type { ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { ToastRegion } from "../Toast";
import { CopyButton } from "./CopyButton";

const URL_TO_COPY = "https://haulcast.example/plan/demo";

/** Kitchen-sink states of {@link CopyButton}: both sizes and disabled. */
export default function CopyButtonDemo(): ReactElement {
  const messages = {
    successMessage: copy.app.copyLinkDone,
    failureMessage: copy.app.copyLinkFailed,
  };
  return (
    <DemoGrid>
      <DemoState title="Medium">
        <CopyButton text={URL_TO_COPY} {...messages}>
          {copy.app.copyLink}
        </CopyButton>
      </DemoState>
      <DemoState title="Small">
        <CopyButton text={URL_TO_COPY} size="sm" {...messages}>
          {copy.app.copyLink}
        </CopyButton>
      </DemoState>
      <DemoState title="Disabled">
        <CopyButton text={URL_TO_COPY} isDisabled {...messages}>
          {copy.app.copyLink}
        </CopyButton>
      </DemoState>
      <ToastRegion closeLabel="Close" />
    </DemoGrid>
  );
}
