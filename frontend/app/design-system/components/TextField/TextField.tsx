import type { ReactElement, ReactNode } from "react";
import {
  Input,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../_shared/FieldParts";
import styles from "./TextField.module.css";

/** Props for {@link TextField}. */
export interface TextFieldProps extends Omit<
  AriaTextFieldProps,
  "className" | "style" | "children" | "validationBehavior"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Hint shown under the control, read out with the field. */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a failing `validate`). */
  readonly errorMessage?: FieldErrorContent;
  /** Example input shown while empty. It never replaces the label. */
  readonly placeholder?: string;
}

/**
 * Single-line text input: label above, 40 px control (44 px on touch widths), hint and error below.
 * Errors show as soon as the field is invalid, so a form can validate with Zod and pass the
 * result through `isInvalid` + `errorMessage`.
 */
export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  ...props
}: TextFieldProps): ReactElement {
  return (
    <AriaTextField {...props} validationBehavior="aria" className={fieldRootClass}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        className={cx(fieldControlClass, styles["input"])}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError>{errorMessage}</FieldError>
    </AriaTextField>
  );
}
