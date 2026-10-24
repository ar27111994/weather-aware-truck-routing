import { LoaderCircle, RotateCcwClock, Search, X } from "lucide-react";
import { useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from "react";
import {
  ButtonContext,
  Collection,
  ComboBox as AriaComboBox,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Text,
  type ComboBoxProps as AriaComboBoxProps,
  type Key,
  type ListBoxItemProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { useScrollDispatch } from "../../foundation/useScrollDispatch";
import { typography } from "../_shared/typography";
import { Button } from "../Button";
import {
  FieldButton,
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../_shared/FieldParts";
import styles from "./ComboBox.module.css";
import { ComboBoxPopover } from "./ComboBoxPopover";
import { listParts, listPopoverStyle } from "./ListParts";

/** Where the consumer's search is: nothing running, a request in flight, or a failed request. */
export type ComboBoxStatus = "idle" | "loading" | "error";

/** Props for {@link ComboBoxItem}. */
export interface ComboBoxItemProps extends Omit<
  ListBoxItemProps,
  "className" | "style" | "children" | "textValue" | "id" | "value"
> {
  /** Stable key of the item; it is what `value` and `onChange` carry. */
  readonly id: Key;
  /** Plain text of the item: what the input shows once it is chosen and what type-ahead matches. */
  readonly textValue: string;
  /** The item's name, in body text. */
  readonly title: ReactNode;
  /** Region and country, in secondary body-sm text under the title. */
  readonly subtitle?: ReactNode;
  /** The kind of place, in tertiary caption text after the subtitle. */
  readonly meta?: ReactNode;
}

/** One option of a {@link ComboBox}: title, then subtitle and meta, read out as name and description. */
export function ComboBoxItem({ title, subtitle, meta, ...props }: ComboBoxItemProps): ReactElement {
  const hasDetail = subtitle !== undefined || meta !== undefined;
  return (
    <ListBoxItem {...props} className={listParts.item}>
      <Text slot="label" className={listParts.title}>
        {title}
      </Text>
      {hasDetail ? (
        <Text slot="description" className={listParts.detail}>
          {subtitle === undefined ? null : <span>{subtitle}</span>}{" "}
          {meta === undefined ? null : <span className={listParts.meta}>{meta}</span>}
        </Text>
      ) : null}
    </ListBoxItem>
  );
}

/** Props for {@link ComboBox}. */
export interface ComboBoxProps<T extends object> extends Omit<
  AriaComboBoxProps<T>,
  | "className"
  | "style"
  | "children"
  | "items"
  | "defaultItems"
  | "validationBehavior"
  | "allowsEmptyCollection"
  | "menuTrigger"
  | "defaultFilter"
  | "formValue"
  | "placeholder"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Hint shown under the control, read out with the field. */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a failing `validate`). */
  readonly errorMessage?: FieldErrorContent;
  /** Example input shown while empty. It never replaces the label. */
  readonly placeholder?: string;
  /**
   * The results to list. The consumer owns them (debounce, abort and fetching included): the
   * component never filters them on the client.
   */
  readonly items: readonly T[];
  /** Places used before, listed under "Recent" while the input is focused and empty. */
  readonly recentItems?: readonly T[];
  /**
   * Renders one item as a {@link ComboBoxItem}. Its `id` and `textValue` are read back to find the
   * text of the chosen item.
   */
  readonly children: (item: T) => ReactElement<ComboBoxItemProps>;
  /** State of the consumer's search; defaults to `idle`. */
  readonly status?: ComboBoxStatus;
  /** Called when "Retry" is pressed in the error state. */
  readonly onRetry?: () => void;
}

type View = "recent" | "tooShort" | "error" | "loading" | "empty" | "results";

/** The fewest letters a search starts with. DESIGN.md fixes it at two, and the copy says so. */
const MIN_QUERY_LENGTH = 2;

const noItems: readonly never[] = [];

function resolveView(
  query: string,
  status: ComboBoxStatus,
  resultCount: number,
  recentCount: number,
): View {
  if (query === "" && recentCount > 0) {
    return "recent";
  }
  if (query.length < MIN_QUERY_LENGTH) {
    return "tooShort";
  }
  if (status === "error") {
    return "error";
  }
  if (status === "loading") {
    return "loading";
  }
  return resultCount === 0 ? "empty" : "results";
}

function StatusText({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className={cx(styles.statusText)}>{children}</span>;
}

function StatusRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div role="status" className={cx(styles.status, typography.bodySm)}>
      {children}
    </div>
  );
}

/**
 * Brings the input into view when it takes focus, so that its list opens next to a field the
 * visitor can see. A browser scrolls a field that takes focus into view; WebKit does not when a
 * script focuses a field that is scrolled out of the sheet's content, and the list then opened
 * above the screen (R4-01, the iPhone 14 in `e2e/early-input.spec.ts`). `nearest` moves nothing
 * for a field that is already in view.
 */
function revealInput(event: FocusEvent<HTMLInputElement>): void {
  event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Place search: a text input that lists the results the consumer passes in. Typing under the
 * minimum length, loading, empty and error each get their own message in the popover; "Recent"
 * places show while the empty input is focused. Arrow keys, Enter and Escape are React Aria's.
 */
export function ComboBox<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  items,
  recentItems,
  children,
  status = "idle",
  onRetry,
  inputValue: controlledInputValue,
  defaultInputValue = "",
  onInputChange,
  ...props
}: ComboBoxProps<T>): ReactElement {
  const [uncontrolledInputValue, setUncontrolledInputValue] = useState(defaultInputValue);
  const [seenValue, setSeenValue] = useState(props.value);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrolling = useScrollDispatch();

  const inputValue = controlledInputValue ?? uncontrolledInputValue;
  const query = inputValue.trim();
  const recent: readonly T[] = recentItems ?? noItems;
  const view = resolveView(query, status, items.length, recent.length);
  const optionsByView: Record<View, readonly T[]> = {
    recent,
    tooShort: noItems,
    error: noItems,
    loading: items,
    empty: noItems,
    results: items,
  };
  const options = optionsByView[view];
  const sectionId = view === "recent" ? "recent" : "results";
  const heading =
    view === "recent"
      ? { icon: <RotateCcwClock size={16} aria-hidden="true" />, text: t("search.recent") }
      : { icon: null, text: t("search.results") };
  const showClear = inputValue !== "" && props.isDisabled !== true && props.isReadOnly !== true;

  // Emptying the input also empties the selection; React Aria does it for an uncontrolled
  // selection, a controlled one is reported through `onChange`.
  function handleInputChange(value: string): void {
    if (controlledInputValue === undefined) {
      setUncontrolledInputValue(value);
    }
    onInputChange?.(value);
    if (value === "" && props.value !== undefined) {
      props.onChange?.(null);
    }
  }

  // The text of the listed item that `key` names, when there is one.
  function textOf(key: Key | null): string | undefined {
    for (const item of [...recent, ...items]) {
      const { id, textValue } = children(item).props;
      if (id === key) {
        return textValue;
      }
    }
    return undefined;
  }

  // With the value and the input both controlled React Aria never writes the text of the chosen
  // item (R3-03), so a pick writes it here and a value that the parent sets shows its own text.
  function handleChange(key: Key | null): void {
    props.onChange?.(key);
    const text = textOf(key);
    if (props.value !== undefined && text !== undefined) {
      handleInputChange(text);
    }
  }

  if (props.value !== seenValue) {
    setSeenValue(props.value);
    const text = props.value == null ? "" : textOf(props.value);
    if (controlledInputValue === undefined && text !== undefined) {
      setUncontrolledInputValue(text);
    }
  }

  function clear(): void {
    handleInputChange("");
    inputRef.current?.focus();
  }

  function retry(): void {
    onRetry?.();
    inputRef.current?.focus();
  }

  return (
    <AriaComboBox
      {...props}
      items={options}
      allowsEmptyCollection
      menuTrigger={recent.length > 0 ? "focus" : "input"}
      validationBehavior="aria"
      inputValue={inputValue}
      onInputChange={handleInputChange}
      onChange={handleChange}
      className={fieldRootClass}
    >
      <FieldLabel>{label}</FieldLabel>
      <div className={cx(styles.inputWrap)}>
        <Search className={cx(styles.searchIcon)} size={20} aria-hidden="true" />
        <Input
          ref={inputRef}
          onFocus={revealInput}
          className={cx(fieldControlClass, styles.input)}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
        {showClear ? (
          // The combo box hands its own toggle-button props to every Button inside it; the clear
          // button is a plain button, so that context is cleared around it.
          <ButtonContext.Provider value={null}>
            <div className={cx(styles.clearSlot)}>
              <FieldButton aria-label={t("search.clear")} excludeFromTabOrder onPress={clear}>
                <X size={20} aria-hidden="true" />
              </FieldButton>
            </div>
          </ButtonContext.Provider>
        ) : null}
      </div>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError>{errorMessage}</FieldError>
      <ComboBoxPopover
        scrolling={scrolling}
        input={inputRef}
        className={listParts.popover}
        style={listPopoverStyle}
      >
        {view === "tooShort" ? (
          <StatusRow>
            <StatusText>{t("search.tooShort")}</StatusText>
          </StatusRow>
        ) : null}
        {view === "loading" ? (
          <StatusRow>
            <LoaderCircle className={cx(styles.spinner)} size={20} aria-hidden="true" />
            <StatusText>{t("search.loading")}</StatusText>
          </StatusRow>
        ) : null}
        {view === "empty" ? (
          <StatusRow>
            <StatusText>{t("search.empty", { query })}</StatusText>
          </StatusRow>
        ) : null}
        {view === "error" ? (
          <StatusRow>
            <StatusText>{t("search.error")}</StatusText>
            <Button variant="ghost" size="sm" preventFocusOnPress onPress={retry}>
              {t("search.retry")}
            </Button>
          </StatusRow>
        ) : null}
        <ListBox className={listParts.list} data-loading={view === "loading" ? "" : undefined}>
          {options.length > 0 ? (
            <ListBoxSection key={sectionId} id={sectionId} className={listParts.section}>
              <Header className={listParts.header}>
                {heading.icon}
                <span>{heading.text}</span>
              </Header>
              <Collection items={options}>{children}</Collection>
            </ListBoxSection>
          ) : null}
        </ListBox>
      </ComboBoxPopover>
    </AriaComboBox>
  );
}
