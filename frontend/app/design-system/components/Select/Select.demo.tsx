import type { Demo } from "../../foundation/demo";
import type { ReactElement } from "react";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { Select, SelectItem } from "./Select";

interface Source {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

const live: Source = { id: "live", name: t("form.scenario.live") };
const sources: readonly Source[] = [
  live,
  { id: "storm", name: "Winter storm", description: "Heavy snow along I-80." },
  { id: "fog", name: "Dense fog", description: "Low visibility in river valleys." },
];

function renderSource(source: Source): ReactElement {
  return (
    <SelectItem
      id={source.id}
      textValue={source.name}
      {...(source.description === undefined ? {} : { description: source.description })}
    >
      {source.name}
    </SelectItem>
  );
}

/** Kitchen-sink states of {@link Select}. The option list opens when the field is used. */
function SelectDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Default">
        <Select<Source>
          label={t("form.scenario.label")}
          description={t("form.scenario.hint")}
          items={sources}
          defaultValue="live"
        >
          {renderSource}
        </Select>
      </DemoState>
      <DemoState title="Placeholder">
        <Select<Source> label={t("form.scenario.label")} placeholder="Choose one" items={sources}>
          {renderSource}
        </Select>
      </DemoState>
      <DemoState title="Loading scenarios">
        <Select<Source>
          label={t("form.scenario.label")}
          items={[live]}
          defaultValue="live"
          status="loading"
          loadingMessage={t("form.scenario.loading")}
        >
          {renderSource}
        </Select>
      </DemoState>
      <DemoState title="Scenarios unavailable">
        <Select<Source>
          label={t("form.scenario.label")}
          items={[live]}
          defaultValue="live"
          status="error"
          unavailableMessage={t("form.scenario.unavailable")}
        >
          {renderSource}
        </Select>
      </DemoState>
      <DemoState title="Invalid">
        <Select<Source>
          label={t("form.scenario.label")}
          items={sources}
          isInvalid
          errorMessage="Choose a weather source."
        >
          {renderSource}
        </Select>
      </DemoState>
      <DemoState title="Disabled">
        <Select<Source>
          label={t("form.scenario.label")}
          items={sources}
          defaultValue="live"
          isDisabled
        >
          {renderSource}
        </Select>
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for Select: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "Select",
  description: "Single-choice dropdown that looks like a text field.",
  states: [{ id: "states", title: "States", node: <SelectDemo /> }],
};
