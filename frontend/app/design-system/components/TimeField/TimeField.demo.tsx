import type { Demo } from "../../foundation/demo";
import { Time } from "@internationalized/date";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria-components";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { TimeField } from "./TimeField";

const label = t("form.departure.timeLabel");

/** Kitchen-sink states of {@link TimeField}. */
function TimeFieldDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="en-US, 12-hour">
        <I18nProvider locale="en-US">
          <TimeField label={label} defaultValue={new Time(14, 30)} />
        </I18nProvider>
      </DemoState>
      <DemoState title="en-GB, 24-hour">
        <I18nProvider locale="en-GB">
          <TimeField label={label} defaultValue={new Time(14, 30)} />
        </I18nProvider>
      </DemoState>
      <DemoState title="Empty with hint">
        <TimeField label={label} description="Local time" />
      </DemoState>
      <DemoState title="Invalid">
        <TimeField
          label={label}
          defaultValue={new Time(3, 0)}
          minValue={new Time(6, 0)}
          errorMessage={t("form.departure.error.range")}
        />
      </DemoState>
      <DemoState title="Disabled">
        <TimeField label={label} defaultValue={new Time(14, 30)} isDisabled />
      </DemoState>
      <DemoState title="Read only">
        <TimeField label={label} defaultValue={new Time(14, 30)} isReadOnly />
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for TimeField: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "TimeField",
  description: "Locale-driven time field with segments.",
  states: [{ id: "states", title: "States", node: <TimeFieldDemo /> }],
};
