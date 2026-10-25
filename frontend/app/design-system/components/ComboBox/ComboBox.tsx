import { LoaderCircle, RotateCcwClock, Search, X } from "lucide-react";
import {
  useContext,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ButtonContext,
  Collection,
  ComboBox as AriaComboBox,
  ComboBoxStateContext,
  Header,
  Input,
  LabelContext,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  useSlottedContext,
  type ComboBoxProps as AriaComboBoxProps,
  type Key,
  type ListBoxItemProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { useScrollDispatch } from "../../foundation/useScrollDispatch";
import { typography } from "../_shared/typography";
import { Button } from "../Button";
import { VisuallyHidden } from "../VisuallyHidden";
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
import { OptionLines } from "./OptionLines";

/** Where the consumer's search is: nothing running, a request in flight, or a failed request. */
export type ComboBoxStatus = "idle" | "loading" | "error";

/** Props for {@link ComboBoxItem}. */
export interface ComboBoxItemProps extends Omit<
  ListBoxItemProps,
  "className" | "style" | "children" | "textValue" | "id" | "value"
> {
  /** Stable key of the item; it is what `value` and `onChange` carry. */
  readonly id: Key;
  /**
   * Plain text of the item: what the input shows once it is chosen and what type-ahead matches.
   * It is the title only: the accessible name of the option also holds its subtitle and meta.
   */
  readonly textValue: string;
  /** The item's name, in body text. */
  readonly title: ReactNode;
  /** Region and country, in secondary body-sm text under the title. */
  readonly subtitle?: ReactNode;
  /** The kind of place, in tertiary caption text after the subtitle. */
  readonly meta?: ReactNode;
}

/**
 * One option of a {@link ComboBox}: title, then subtitle and meta. The option is named by all the
 * text it shows, the title first, and has no description of its own (WCAG 2.5.3 Label in Name,
 * D-58; see {@link OptionLines}).
 */
export function ComboBoxItem({ title, subtitle, meta, ...props }: ComboBoxItemProps): ReactElement {
  const hasDetail = subtitle !== undefined || meta !== undefined;
  return (
    <ListBoxItem {...props} className={listParts.item}>
      <OptionLines
        title={title}
        detail={
          hasDetail ? (
            <>
              {subtitle === undefined ? null : <span>{subtitle}</span>}{" "}
              {meta === undefined ? null : <span className={listParts.meta}>{meta}</span>}
            </>
          ) : undefined
        }
      />
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
  // Fixed: leaving the field keeps its text, see `handleChange` (D-56).
  | "allowsCustomValue"
  // React Aria's older names for `value`, `defaultValue` and `onChange`: the combo box holds the
  // selected key itself and would not read them.
  | "selectedKey"
  | "defaultSelectedKey"
  | "onSelectionChange"
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
  return <div className={cx(styles.status, typography.bodySm)}>{children}</div>;
}

/**
 * The one live region of a combo box: in the page from the first render, empty until the search
 * has a message to say, and empty again when the list closes. A live region that appears together
 * with its text is not reliably read out, and that is what the rows of the popover are (R3-25).
 *
 * WORKAROUND (private React Aria mark). React Aria hides everything but the input and the list
 * from assistive technology while the list is open, and the list is open whenever there is a
 * message. It leaves an element alone that carries `data-live-announcer`, the mark of its own
 * announcer, so this region carries it too. That mark is private to React Aria: react-aria 3.53.1
 * has no public way to keep a consumer's live region exposed while the list is open, and no public
 * `announce()` (it exists only under `dist/private/live-announcer`; the public index exports
 * neither). The test "keeps the live region exposed to assistive technology while the list is
 * open" pins the mark: it fails when a React Aria release stops honouring it.
 *
 * Hazard: React Aria's aria-modal polyfill, `watchModals`, keeps only the FIRST
 * `[data-live-announcer="true"]` element exposed next to a modal. This app does not use it today,
 * and if it ever does, this region could displace React Aria's own announcer.
 * `liveRegionHazard.test.ts` fails when a file under `app/` imports it.
 *
 * When a React Aria release offers a public announce() or a public way to keep a live region
 * exposed, use it and drop the mark.
 */
function SearchAnnouncer({ message }: { readonly message: string }): ReactElement {
  const comboBox = useContext(ComboBoxStateContext);
  return (
    <div role="status" aria-live="polite" data-live-announcer="true">
      <VisuallyHidden>{comboBox?.isOpen === true ? message : ""}</VisuallyHidden>
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
 * The button that empties the field. It is named "Clear" and then the label of its field ("Clear
 * Origin"): a page with two fields, the planner's From and To, would have two buttons that are
 * both called "Clear" otherwise (R3-23). The button names itself first and the field's label
 * follows (`aria-labelledby` lists the button's own id, then the label's).
 */
function ClearButton({ onPress }: { readonly onPress: () => void }): ReactElement {
  const id = useId();
  const labelId = useSlottedContext(LabelContext)?.id;
  return (
    <FieldButton
      id={id}
      aria-label={t("search.clear")}
      {...(labelId === undefined ? {} : { "aria-labelledby": `${id} ${labelId}` })}
      excludeFromTabOrder
      onPress={onPress}
    >
      <X size={20} aria-hidden="true" />
    </FieldButton>
  );
}

/**
 * Place search: a text input that lists the results the consumer passes in. Typing under the
 * minimum length, loading, empty and error each get their own message in the popover; "Recent"
 * places show while the empty input is focused. Arrow keys, Enter and Escape are React Aria's.
 *
 * Leaving the field never deletes its text (D-56): focus, Tab, Enter and Escape close the list and
 * what is in the input stays, whether it was typed or the parent put it there (a place that a
 * shared link restored). A place that was chosen here is put back when its text was edited
 * (R3-14). What text that names no place means is for the consumer to decide. A named field posts
 * the key of the chosen item, and nothing for text that names no item.
 *
 * The messages are also written into one live region that is in the page from the first render,
 * empty until there is a message, so that screen readers read them out (R3-25): a live region that
 * appears together with its text is not reliably announced, and that is what the rows are.
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
  value: controlledValue,
  defaultValue = null,
  onChange,
  name,
  ...props
}: ComboBoxProps<T>): ReactElement {
  const [uncontrolledInputValue, setUncontrolledInputValue] = useState(defaultInputValue);
  const [uncontrolledValue, setUncontrolledValue] = useState<Key | null>(defaultValue);
  // The item that was chosen: its key and its text. The item can leave the list that the consumer
  // passes in (the next search lists other places, and a place from "Recent" is in no search), and
  // React Aria finds the text of a key only in the list that is showing: it takes the text out of
  // the field when focus leaves and the key is not in that list (R3-14). So the text is kept here.
  const [chosen, setChosen] = useState<{ readonly key: Key; readonly text: string } | null>(null);
  const [seenValue, setSeenValue] = useState(controlledValue);
  // The text that this combo box last reported through `onInputChange`, and the text its parent
  // last passed in. The parent can set the text itself (the planner's swap button moves it from
  // one field to the other): text that was not reported is the parent's, and a place chosen here
  // no longer describes it (see below).
  const [reportedInput, setReportedInput] = useState(controlledInputValue);
  const [seenInput, setSeenInput] = useState(controlledInputValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrolling = useScrollDispatch();

  const inputValue = controlledInputValue ?? uncontrolledInputValue;
  const selectedKey = controlledValue === undefined ? uncontrolledValue : controlledValue;
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
  // What the live region says: the words of the row that the popover shows, and nothing while it
  // lists places (React Aria announces how many there are).
  const messages: Record<View, string> = {
    recent: "",
    tooShort: t("search.tooShort"),
    error: t("search.error"),
    loading: t("search.loading"),
    empty: t("search.empty", { query }),
    results: "",
  };
  const sectionId = view === "recent" ? "recent" : "results";
  const heading =
    view === "recent"
      ? { icon: <RotateCcwClock size={16} aria-hidden="true" />, text: t("search.recent") }
      : { icon: null, text: t("search.results") };
  const showClear = inputValue !== "" && props.isDisabled !== true && props.isReadOnly !== true;

  // The text of the item that `key` names: the chosen one (kept, see above) or one that is listed.
  function textOf(key: Key | null): string | undefined {
    if (chosen !== null && chosen.key === key) {
      return chosen.text;
    }
    for (const item of [...recent, ...items]) {
      const { id, textValue } = children(item).props;
      if (id === key) {
        return textValue;
      }
    }
    return undefined;
  }

  // Emptying the input also empties the selection.
  function handleInputChange(value: string): void {
    setReportedInput(value);
    if (controlledInputValue === undefined) {
      setUncontrolledInputValue(value);
    }
    onInputChange?.(value);
    if (value === "" && selectedKey !== null) {
      setUncontrolledValue(null);
      setChosen(null);
      onChange?.(null);
    }
  }

  // The combo box holds the selected key and gives it to React Aria as a controlled value, so
  // React Aria never writes a text of its own: a pick writes the text of the item here (R3-03),
  // and a key that has left the list is not taken for no selection (R3-14).
  //
  // Leaving the field (focus, Tab, Enter or Escape) commits it, and `allowsCustomValue` makes that
  // commit keep the text as it is (D-56). React Aria reports `null` when the text is not the text
  // of an item it can find in the list that is showing, and the same key when Escape reverts. Both
  // are no change here, so the consumer is not told: leaving the field does not clear a chosen
  // place, emptying it does (`handleInputChange`). What is done with the text is the whole rule:
  //  - a place was chosen here: its text is put back if it is known and differs, so a pick that
  //    was edited goes back to the pick (R3-14);
  //  - nothing was chosen here: there is nothing to put back, and the text stays, whether it was
  //    typed or the parent put it there (a place that a shared link restored). Whether it names a
  //    place is for the parent to say; the planner's form says so when it is submitted.
  function handleChange(key: Key | null): void {
    if (key === null || key === selectedKey) {
      const text = textOf(selectedKey);
      if (text !== undefined && text !== inputValue) {
        handleInputChange(text);
      }
      return;
    }
    const text = textOf(key);
    setUncontrolledValue(key);
    onChange?.(key);
    // A pick is one of the listed items, so its text is known.
    if (text !== undefined) {
      setChosen({ key, text });
      handleInputChange(text);
    }
  }

  // Text that the parent set and this combo box did not report is the parent's: a place chosen
  // here describes text that is no longer in the field, and leaving the field would write that old
  // text back over the parent's. The chosen place is let go; the parent decides what its text means.
  if (controlledInputValue !== seenInput) {
    setSeenInput(controlledInputValue);
    if (controlledInputValue !== reportedInput) {
      setUncontrolledValue(null);
      setChosen(null);
    }
  }

  if (controlledValue !== seenValue) {
    setSeenValue(controlledValue);
    const text = controlledValue == null ? "" : textOf(controlledValue);
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
      allowsCustomValue
      menuTrigger={recent.length > 0 ? "focus" : "input"}
      validationBehavior="aria"
      inputValue={inputValue}
      onInputChange={handleInputChange}
      value={selectedKey}
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
              <ClearButton onPress={clear} />
            </div>
          </ButtonContext.Provider>
        ) : null}
        <SearchAnnouncer message={messages[view]} />
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
      {name === undefined ? null : (
        // With `allowsCustomValue` React Aria posts the text of the input under `name`. A form gets
        // what a `select` gets: the key of the chosen item, and nothing for text that names no item.
        <input type="hidden" name={name} form={props.form} value={selectedKey ?? ""} />
      )}
    </AriaComboBox>
  );
}
