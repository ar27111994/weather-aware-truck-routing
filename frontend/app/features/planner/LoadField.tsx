import type { ReactElement } from "react";

import { ActionChip } from "../../design-system/components/Chip";
import { NumberField } from "../../design-system/components/NumberField";
import { t } from "../../design-system/foundation/strings";
import { LOAD_LIMITS_LB } from "../../lib/risk";
import { grossWeightHint, loadHint } from "./load-hint";
import styles from "./LoadField.module.css";

/** Common loads, from the design: the lightest is the empty trailer. */
const PRESETS = [
  { pounds: 0, label: "form.load.presets.empty" },
  { pounds: 20_000, label: "form.load.presets.p20000" },
  { pounds: 38_000, label: "form.load.presets.p38000" },
  { pounds: 45_000, label: "form.load.presets.p45000" },
  { pounds: 80_000, label: "form.load.presets.p80000" },
] as const satisfies readonly { pounds: number; label: Parameters<typeof t>[0] }[];

/** One step of the plus and minus buttons, in pounds. */
const STEP_LB = 1_000;

/** Props for {@link LoadField}. */
export interface LoadFieldProps {
  /** Pounds; `NaN` while the field is empty. */
  readonly value: number;
  readonly onChange: (pounds: number) => void;
  readonly errorMessage?: string | undefined;
}

/**
 * Load weight in pounds (R1) with steppers, the common loads as one-press presets, and a live hint
 * saying which load rules apply at this weight and what gross weight routing uses. The hint is read
 * out politely as it changes.
 */
export function LoadField({ value, onChange, errorMessage }: LoadFieldProps): ReactElement {
  const gross = grossWeightHint(value);
  return (
    <NumberField
      label={t("form.load.label")}
      unit={t("form.load.unit")}
      decrementLabel={t("form.load.decrement")}
      incrementLabel={t("form.load.increment")}
      value={value}
      onChange={onChange}
      minValue={LOAD_LIMITS_LB.min}
      maxValue={LOAD_LIMITS_LB.max}
      step={STEP_LB}
      formatOptions={{ maximumFractionDigits: 0, useGrouping: true }}
      presets={
        <div role="group" aria-label={t("form.load.presetsLabel")} className={styles.presets}>
          {PRESETS.map((preset) => (
            <ActionChip
              key={preset.pounds}
              onPress={() => {
                onChange(preset.pounds);
              }}
            >
              {t(preset.label)}
            </ActionChip>
          ))}
        </div>
      }
      description={gross === null ? loadHint(value) : `${loadHint(value)} ${gross}`}
      isInvalid={errorMessage !== undefined}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    />
  );
}
