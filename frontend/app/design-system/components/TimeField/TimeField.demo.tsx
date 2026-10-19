import { Time } from "@internationalized/date";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria-components";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { TimeField } from "./TimeField";

const label = copy.form.departure.timeLabel;

/** Kitchen-sink states of {@link TimeField}. */
export default function TimeFieldDemo(): ReactElement {
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
          errorMessage={copy.form.departure.error.range}
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
