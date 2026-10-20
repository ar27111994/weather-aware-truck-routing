import type { ReactElement, ReactNode } from "react";
import {
  TimeField as AriaTimeField,
  type TimeFieldProps as AriaTimeFieldProps,
  type TimeValue,
} from "react-aria-components";

import {
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldRootClass,
  type FieldErrorContent,
} from "../_shared/FieldParts";
import { Segments } from "./Segments";

/** Props for {@link TimeField}. */
export interface TimeFieldProps extends Omit<
  AriaTimeFieldProps<TimeValue>,
  "className" | "style" | "children" | "validationBehavior" | "aria-label" | "hourCycle"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Hint shown under the control, read out with the field. */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a value outside min / max). */
  readonly errorMessage?: FieldErrorContent;
}

/**
 * Time-of-day input made of editable segments inside the shared control box. The clock follows
 * the user's locale (en-US: 12-hour with an AM/PM segment, en-GB: 24-hour); the hour cycle is
 * deliberately not forced.
 */
export function TimeField({
  label,
  description,
  errorMessage,
  ...props
}: TimeFieldProps): ReactElement {
  return (
    <AriaTimeField {...props} validationBehavior="aria" className={fieldRootClass}>
      <FieldLabel>{label}</FieldLabel>
      <Segments />
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError>{errorMessage}</FieldError>
    </AriaTimeField>
  );
}
