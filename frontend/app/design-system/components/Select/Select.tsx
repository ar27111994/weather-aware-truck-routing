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

import { cls } from "../../cls";
import { typography } from "../_shared/typography";
import { listParts, listPopoverStyle } from "../ComboBox/ListParts";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../FieldParts";
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
 * while its options load or fail to load, one extra option with the caller's message says so.
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
      <FieldLabel>{label}</FieldLabel>
      <Button
        className={cls(fieldControlClass, styles["trigger"])}
        data-invalid={props.isInvalid === true ? "true" : undefined}
      >
        <SelectValue className={cls(styles["value"])}>
          {({ isPlaceholder, selectedText, defaultChildren }) =>
            isPlaceholder ? defaultChildren : selectedText
          }
        </SelectValue>
        <ChevronDown className={cls(styles["chevron"])} size={20} aria-hidden="true" />
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
              <Text slot="label" className={cls(listParts.title, typography.body)}>
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
              <Text slot="label" className={cls(listParts.title, typography.body)}>
                {unavailableMessage}
              </Text>
            </ListBoxItem>
          ) : null}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
