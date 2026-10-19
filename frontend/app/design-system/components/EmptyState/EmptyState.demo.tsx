import type { ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { EmptyState } from "./EmptyState";

/** Kitchen-sink states of {@link EmptyState}. */
export default function EmptyStateDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Title and body">
        <EmptyState title={copy.empty.title}>{copy.empty.body}</EmptyState>
      </DemoState>
      <DemoState title="With steps and action">
        <EmptyState
          title={copy.empty.title}
          steps={copy.empty.steps}
          stepsLabel="How it works"
          action={<a href="#demo-scenario">{copy.empty.tryScenario}</a>}
        >
          {copy.empty.body}
        </EmptyState>
      </DemoState>
    </DemoGrid>
  );
}
