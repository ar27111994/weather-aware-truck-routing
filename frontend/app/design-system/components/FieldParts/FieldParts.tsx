import { CircleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  Button,
  FieldError as AriaFieldError,
  Label,
  Text,
  type ButtonProps,
  type ValidationResult,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import styles from "./FieldParts.module.css";

/** Class for the root of a form field: label, control, hint and error stacked in one column. */
export const fieldRootClass = cx(styles["field"]);

/**
 * Class for the bordered box shared by every text-entry control (an `Input`, a `Group` wrapping
 * several parts, a `Select` button). Its height follows the touch / desktop rule of the design.
 */
export const fieldControlClass = cx(styles["control"], typography.body);

/** The visible label of a field (always present: a placeholder is never a label). */
export function FieldLabel({ children }: { readonly children: ReactNode }): ReactElement {
  return <Label className={cx(styles["label"], typography.label)}>{children}</Label>;
}

/** The hint under a field, announced through `aria-describedby`. */
export function FieldDescription({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Text slot="description" className={cx(styles["description"], typography.bodySm)}>
      {children}
    </Text>
  );
}

/** What a field can show as its error: fixed content, or a function of the validation result. */
export type FieldErrorContent = ReactNode | ((validation: ValidationResult) => ReactNode);

/**
 * The error under a field. React Aria renders it only while the field is invalid and wires it into
 * `aria-describedby`; with no content given it falls back to the validation messages themselves.
 */
export function FieldError({ children }: { readonly children?: FieldErrorContent }): ReactElement {
  return (
    <AriaFieldError className={cx(styles["error"], typography.bodySm)}>
      {(validation) => (
        <>
          <CircleAlert className={cx(styles["errorIcon"])} size={16} aria-hidden="true" />
          <span>
            {typeof children === "function"
              ? children(validation)
              : (children ?? validation.validationErrors.join(" "))}
          </span>
        </>
      )}
    </AriaFieldError>
  );
}

/** Props for {@link FieldButton}: a React Aria button that must carry its own accessible name. */
export interface FieldButtonProps extends Omit<ButtonProps, "className" | "style" | "aria-label"> {
  readonly "aria-label": string;
}

/** A square ghost button that sits inside a field control (stepper, calendar toggle, clear). */
export function FieldButton(props: FieldButtonProps): ReactElement {
  return <Button {...props} className={cx(styles["button"])} />;
}
