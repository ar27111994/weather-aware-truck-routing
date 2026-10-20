import type { Demo } from "../../foundation/demo";
import { useState, type ReactElement } from "react";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { Chip } from "../Chip";
import { Inline } from "../Layout";
import { NumberField } from "./NumberField";

const load = {
  label: t("form.load.label"),
  unit: t("form.load.unit"),
  decrement: t("form.load.decrement"),
  increment: t("form.load.increment"),
  presetsLabel: t("form.load.presetsLabel"),
  presets: {
    empty: t("form.load.presets.empty"),
    p20000: t("form.load.presets.p20000"),
    p38000: t("form.load.presets.p38000"),
    p45000: t("form.load.presets.p45000"),
    p80000: t("form.load.presets.p80000"),
  },
  hint: { none: t("form.load.hint.none"), lr2: t("form.load.hint.lr2") },
  error: { range: t("form.load.error.range") },
} as const;
const loadFormat = { maximumFractionDigits: 0, useGrouping: true } as const;

const presetList = [
  { label: `${load.presets.empty} 0`, value: 0 },
  { label: load.presets.p20000, value: 20000 },
  { label: load.presets.p38000, value: 38000 },
  { label: load.presets.p45000, value: 45000 },
  { label: load.presets.p80000, value: 80000 },
] as const;

function hintFor(value: number): string {
  if (value >= 45000) {
    return load.hint.lr2;
  }
  return load.hint.none;
}

function LoadWeightDemo(): ReactElement {
  const [value, setValue] = useState(38000);
  return (
    <NumberField
      label={load.label}
      unit={load.unit}
      decrementLabel={load.decrement}
      incrementLabel={load.increment}
      minValue={0}
      maxValue={80000}
      step={1000}
      formatOptions={loadFormat}
      value={value}
      onChange={setValue}
      presets={
        <Inline gap={2} wrap role="group" aria-label={load.presetsLabel}>
          {presetList.map((preset) => (
            <Chip
              key={preset.value}
              isSelected={value === preset.value}
              onChange={() => {
                setValue(preset.value);
              }}
            >
              {preset.label}
            </Chip>
          ))}
        </Inline>
      }
      description={hintFor(value)}
    />
  );
}

/** Kitchen-sink states of {@link NumberField}. */
function NumberFieldDemo(): ReactElement {
  return (
    <DemoGrid>
      <DemoState title="Load weight with presets and live hint">
        <LoadWeightDemo />
      </DemoState>
      <DemoState title="Default">
        <NumberField
          label={load.label}
          unit={load.unit}
          decrementLabel={load.decrement}
          incrementLabel={load.increment}
          defaultValue={20000}
          step={1000}
          formatOptions={loadFormat}
        />
      </DemoState>
      <DemoState title="Invalid">
        <NumberField
          label={load.label}
          unit={load.unit}
          decrementLabel={load.decrement}
          incrementLabel={load.increment}
          defaultValue={95000}
          formatOptions={loadFormat}
          isInvalid
          errorMessage={load.error.range}
        />
      </DemoState>
      <DemoState title="Disabled">
        <NumberField
          label={load.label}
          unit={load.unit}
          decrementLabel={load.decrement}
          incrementLabel={load.increment}
          defaultValue={20000}
          formatOptions={loadFormat}
          isDisabled
        />
      </DemoState>
      <DemoState title="Read only">
        <NumberField
          label={load.label}
          unit={load.unit}
          decrementLabel={load.decrement}
          incrementLabel={load.increment}
          defaultValue={20000}
          formatOptions={loadFormat}
          isReadOnly
        />
      </DemoState>
    </DemoGrid>
  );
}

/** What the `/design` route renders for NumberField: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "NumberField",
  description: "Numeric field with stepper buttons, a unit suffix and a presets slot.",
  states: [{ id: "states", title: "States", node: <NumberFieldDemo /> }],
};
