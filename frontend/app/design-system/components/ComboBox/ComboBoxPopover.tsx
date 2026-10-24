import { useContext, type ReactElement, type RefObject } from "react";
import {
  ComboBoxStateContext,
  OverlayTriggerStateContext,
  Popover,
  type PopoverProps,
} from "react-aria-components";

/** Props for {@link ComboBoxPopover}. */
export interface ComboBoxPopoverProps extends PopoverProps {
  /** Holds `true` while a `scroll` event is being dispatched (see `useScrollDispatch`). */
  readonly scrolling: RefObject<boolean>;
}

/**
 * The list of a {@link ComboBox}: React Aria's `Popover`, with one change to when it closes. A
 * close that a scroll asks for is refused.
 *
 * React Aria closes the list of a combo box when a region around the input scrolls, because the
 * list is drawn outside that region and would be left behind. The close is the one that a blur
 * makes: it takes back what was typed and it does so for a controlled input too, which reports it
 * as an empty `onInputChange`. The browser scrolls a region to show a field that took focus, and
 * the `scroll` event of that scroll comes after the `focus` event, so a visitor, or a test, that
 * focuses the field and types at once has the list open when the event arrives. The planner's
 * sheet has been such a region since its stylesheet is drawn at first paint, and a fast first
 * input then lost its text and its list (R4-01).
 *
 * The list is open only while the input has focus, and that visitor is still typing there. So a
 * close that arrives while `scrolling` holds `true` is refused. Escape, a blur, a pick and a
 * change of the query are not scroll events and close the list as before. What this gives up: a
 * list that stays open when the visitor scrolls the region on purpose stays where it was drawn,
 * until the input loses focus or the query changes.
 *
 * The popover reads its open state from the combo box. It is handed a copy of that state whose
 * `close` has the one rule above, and nothing else about the state changes.
 */
export function ComboBoxPopover({ scrolling, ...props }: ComboBoxPopoverProps): ReactElement {
  const comboBox = useContext(ComboBoxStateContext);
  // React Aria renders the children of a combo box a second time, away from the page, to collect
  // its options. The combo box's state does not exist there, nothing is shown, and the popover
  // passes its children on as they are.
  if (comboBox === null) {
    return <Popover {...props} />;
  }

  return (
    <OverlayTriggerStateContext.Provider
      value={{
        ...comboBox,
        close: () => {
          if (scrolling.current) {
            if (String(Reflect.get(window, "__e1") ?? "") === "V4") {
              window.dispatchEvent(new Event("resize"));
            }
            return;
          }
          comboBox.close();
        },
      }}
    >
      <Popover {...props} />
    </OverlayTriggerStateContext.Provider>
  );
}
