import { useState, type ReactElement } from "react";
import { Button } from "react-aria-components";

import { cls } from "../../cls";
import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import styles from "./NumberField.demo.module.css";
import { NumberField } from "./NumberField";

const load = copy.form.load;
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
        <div className={cls(styles["presetRow"])} role="group" aria-label={load.presetsLabel}>
          {presetList.map((preset) => (
            <Button
              key={preset.value}
              className={cls(styles["preset"])}
              onPress={() => {
                setValue(preset.value);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      }
      description={hintFor(value)}
    />
  );
}

/** Kitchen-sink states of {@link NumberField}. */
export default function NumberFieldDemo(): ReactElement {
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
