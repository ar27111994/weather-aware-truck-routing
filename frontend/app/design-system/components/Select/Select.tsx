import { ChevronDown } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  Button,
  Collection,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type Key,
  type ListBoxItemProps,
  type SelectProps as AriaSelectProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import { listParts, listPopoverStyle } from "../ComboBox/ListParts";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../_shared/FieldParts";
import styles from "./Select.module.css";

/** Where the consumer's option list is: ready, still loading, or failed to load. */
export type SelectStatus = "idle" | "loading" | "error";

/** Props for {@link SelectItem}. */
export interface SelectItemProps extends Omit<
  ListBoxItemProps,
  "className" | "style" | "children" | "textValue" | "id" | "value"
> {
  /** Stable key of the item; it is what `value` and `onChange` carry. */
  readonly id: Key;
  /** Plain text of the item: what the trigger shows once it is chosen and what type-ahead matches. */
  readonly textValue: string;
  /** Supporting line under the name, in secondary body-sm text. */
  readonly description?: ReactNode;
  /** The item's name, in body text. */
  readonly children: ReactNode;
}

/** One option of a {@link Select}: a name with an optional description, read out as name and description. */
export function SelectItem({ description, children, ...props }: SelectItemProps): ReactElement {
  return (
    <ListBoxItem {...props} className={listParts.item}>
      <Text slot="label" className={listParts.title}>
        {children}
      </Text>
      {description === undefined ? null : (
        <Text slot="description" className={listParts.detail}>
          {description}
        </Text>
      )}
    </ListBoxItem>
  );
}

/** Props for {@link Select}. */
export interface SelectProps<T extends object> extends Omit<
  AriaSelectProps<T>,
  "className" | "style" | "children" | "items" | "validationBehavior" | "placeholder"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Hint shown under the control, read out with the field. */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a failing `validate`). */
  readonly errorMessage?: FieldErrorContent;
  /** Text shown in the control while nothing is chosen. It never replaces the label. */
  readonly placeholder?: string;
  /** The options to list. */
  readonly items: readonly T[];
  /** Renders one item as a {@link SelectItem}. */
  readonly children: (item: T) => ReactElement;
  /** State of the consumer's option list; defaults to `idle`. */
  readonly status?: SelectStatus;
  /** Text of the one non-selectable option shown while `status` is `loading`. */
  readonly loadingMessage?: string;
  /** Text of the one disabled option shown while `status` is `error`. */
  readonly unavailableMessage?: string;
}

const loadingOptionId = "select-loading";
const unavailableOptionId = "select-unavailable";

/**
 * Drop-down choice that looks like a TextField with a chevron. The consumer's items always list;
 * while its options load or fail to load, one extra option with the caller's message says so. The
 * thicker border of an invalid field follows the validation state that React Aria reports: the
 * `isInvalid` prop and a failing `validate` (R3-10).
 *
 * Contract of `isRequired` (R3-10). In React Aria's `aria` validation mode, which this Select
 * always uses, `isRequired` takes part in no validation: the hidden `<select>` is not `required`,
 * so there is no native constraint to fail, and the trigger gets no `aria-required`. React Aria
 * only reports it as the `isRequired` render prop and as `data-required` on the root. A required
 * Select that is left empty therefore has no invalid state: no `data-invalid` and no error message,
 * whether or not the visitor has been through it. A consumer that needs an error for an empty
 * field passes `isInvalid`, or a `validate` function that returns the message, and `errorMessage`
 * for how it reads. The test "does not take a required field for invalid when it is left empty"
 * pins this. No consumer can leave the field empty today: the planner's weather source always has
 * a chosen option, the live forecast.
 */
export function Select<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  items,
  children,
  status = "idle",
  loadingMessage,
  unavailableMessage,
  ...props
}: SelectProps<T>): ReactElement {
  return (
    <AriaSelect
      {...props}
      validationBehavior="aria"
      className={fieldRootClass}
      {...(placeholder === undefined ? {} : { placeholder })}
    >
      {({ isInvalid }) => (
        <>
          <FieldLabel>{label}</FieldLabel>
          <Button
            className={cx(fieldControlClass, styles.trigger)}
            data-invalid={isInvalid ? "true" : undefined}
          >
            <SelectValue className={cx(styles.value)}>
              {({ isPlaceholder, selectedText, defaultChildren }) =>
                isPlaceholder ? defaultChildren : selectedText
              }
            </SelectValue>
            <ChevronDown className={cx(styles.chevron)} size={20} aria-hidden="true" />
          </Button>
          {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
          <FieldError>{errorMessage}</FieldError>
          <Popover className={listParts.popover} style={listPopoverStyle}>
            <ListBox className={listParts.list}>
              <Collection items={items}>{children}</Collection>
              {status === "loading" && loadingMessage !== undefined ? (
                <ListBoxItem
                  id={loadingOptionId}
                  textValue={loadingMessage}
                  isDisabled
                  className={listParts.item}
                >
                  <Text slot="label" className={cx(listParts.title, typography.body)}>
                    {loadingMessage}
                  </Text>
                </ListBoxItem>
              ) : null}
              {status === "error" && unavailableMessage !== undefined ? (
                <ListBoxItem
                  id={unavailableOptionId}
                  textValue={unavailableMessage}
                  isDisabled
                  className={listParts.item}
                >
                  <Text slot="label" className={cx(listParts.title, typography.body)}>
                    {unavailableMessage}
                  </Text>
                </ListBoxItem>
              ) : null}
            </ListBox>
          </Popover>
        </>
      )}
    </AriaSelect>
  );
}
