import { Minus, Plus } from "lucide-react";
import { useId, type ReactElement, type ReactNode } from "react";
import {
  ButtonContext,
  Group,
  Input,
  NumberField as AriaNumberField,
  type NumberFieldProps as AriaNumberFieldProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import {
  FieldButton,
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../FieldParts";
import styles from "./NumberField.module.css";

/** Props for {@link NumberField}. */
export interface NumberFieldProps extends Omit<
  AriaNumberFieldProps,
  "className" | "style" | "children" | "validationBehavior" | "aria-label" | "aria-describedby"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Live hint under the control. Changes are announced politely (`aria-live="polite"`). */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a failing `validate`). */
  readonly errorMessage?: FieldErrorContent;
  /** Suffix inside the group, for example `lb`. Non-interactive, but read out with the field. */
  readonly unit?: string;
  /** Accessible name of the minus button. The caller supplies it (it is localised copy). */
  readonly decrementLabel: string;
  /** Accessible name of the plus button. The caller supplies it (it is localised copy). */
  readonly incrementLabel: string;
  /** Slot rendered under the control and before the hint, for example a row of preset chips. */
  readonly presets?: ReactNode;
}

/**
 * Numeric input with steppers: label above, a bordered group holding minus, a tabular-numeral
 * input, an optional unit and plus, then presets, a live hint and the error. React Aria supplies
 * typing, locale formatting, clamping and the arrow / Page / Home / End keys.
 */
export function NumberField({
  label,
  description,
  errorMessage,
  unit,
  decrementLabel,
  incrementLabel,
  presets,
  ...props
}: NumberFieldProps): ReactElement {
  const unitId = useId();
  return (
    <AriaNumberField
      {...props}
      validationBehavior="aria"
      {...(unit === undefined ? {} : { "aria-describedby": unitId })}
      className={fieldRootClass}
    >
      <FieldLabel>{label}</FieldLabel>
      <Group className={cx(fieldControlClass, styles["group"])}>
        <FieldButton slot="decrement" aria-label={decrementLabel}>
          <Minus size={20} aria-hidden="true" />
        </FieldButton>
        <Input className={cx(styles["input"])} />
        {unit === undefined ? null : (
          <span id={unitId} className={cx(styles["unit"])}>
            {unit}
          </span>
        )}
        <FieldButton slot="increment" aria-label={incrementLabel}>
          <Plus size={20} aria-hidden="true" />
        </FieldButton>
      </Group>
      {presets === undefined ? null : (
        <div className={cx(styles["presets"])}>
          {/* The steppers' slotted context stops here, so a preset Button is a plain button. */}
          <ButtonContext.Provider value={null}>{presets}</ButtonContext.Provider>
        </div>
      )}
      {description === undefined ? null : (
        <FieldDescription>
          <span aria-live="polite">{description}</span>
        </FieldDescription>
      )}
      <FieldError>{errorMessage}</FieldError>
    </AriaNumberField>
  );
}
