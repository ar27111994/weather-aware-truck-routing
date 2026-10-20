import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { t, tList } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { EmptyState } from "./EmptyState";

/** Kitchen-sink states of {@link EmptyState}. */
function EmptyStateDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Title and body">
        <EmptyState title={t("empty.title")}>{t("empty.body")}</EmptyState>
      </DemoState>
      <DemoState title="With steps and action">
        <EmptyState
          title={t("empty.title")}
          steps={tList("empty.steps")}
          stepsLabel="How it works"
          action={<a href="#demo-scenario">{t("empty.tryScenario")}</a>}
        >
          {t("empty.body")}
        </EmptyState>
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for EmptyState: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "EmptyState",
  description: "What the panel shows before there is anything to show.",
  states: [{ id: "states", title: "States", node: <EmptyStateDemo /> }],
};
