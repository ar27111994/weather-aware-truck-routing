import { useContext, useLayoutEffect, useState, type ReactElement, type RefObject } from "react";
import {
  ComboBoxStateContext,
  OverlayTriggerStateContext,
  Popover,
  type PopoverProps,
} from "react-aria-components";

import { listSideFor, type ListSide } from "./listSide";

/** Props for {@link ComboBoxPopover}. */
export interface ComboBoxPopoverProps extends PopoverProps {
  /** Holds `true` while a `scroll` event is being dispatched (see `useScrollDispatch`). */
  readonly scrolling: RefObject<boolean>;
  /** The input of the combo box: the room around it decides on which side the list opens. */
  readonly input: RefObject<HTMLInputElement | null>;
}

/**
 * The list of a {@link ComboBox}: React Aria's `Popover`, with two changes. A close that a scroll
 * asks for is refused, and the side of the input that the list opens on is chosen from the room
 * around the input and kept.
 *
 * **Scroll.** React Aria closes the list of a combo box when a region around the input scrolls,
 * because the list is drawn outside that region and would be left behind. The close is the one
 * that a blur makes: it takes back what was typed and it does so for a controlled input too, which
 * reports it as an empty `onInputChange`. The browser scrolls a region to show a field that took
 * focus, and the `scroll` event of that scroll comes after the `focus` event, so a visitor, or a
 * test, that focuses the field and types at once has the list open when the event arrives. The
 * planner's sheet has been such a region since its stylesheet is drawn at first paint, and a fast
 * first input then lost its text and its list (R4-01).
 *
 * The list is open only while the input has focus, and that visitor is still typing there. So a
 * close that arrives while `scrolling` holds `true` is refused. Escape, a blur, a pick and a
 * change of the query are not scroll events and close the list as before. What this gives up: a
 * list that stays open when the visitor scrolls the region on purpose stays where it was drawn,
 * until the input loses focus or the query changes.
 *
 * **Side.** React Aria opens a list on the side where it fits, and moves it to the other side when
 * its size changes and it no longer fits. A list changes size while it is open (one row while a
 * search runs, the results after), and the move happens in the callback of the ResizeObserver that
 * watches the list, so the list grows within the frame that reported its size: the browser reports
 * a ResizeObserver loop (R4-01, WebKit; the React Aria maintainers advise setting a side and not
 * letting it flip). The side is chosen when the list opens, and again when the window or the
 * visual viewport changes size, from the room around the input (see {@link listSideFor}), and the
 * popover is told not to flip.
 *
 * The popover reads its open state from the combo box. It is handed a copy of that state whose
 * `close` has the scroll rule above, and nothing else about the state changes.
 */
export function ComboBoxPopover({
  scrolling,
  input,
  ...props
}: ComboBoxPopoverProps): ReactElement {
  const comboBox = useContext(ComboBoxStateContext);
  const isOpen = comboBox?.isOpen === true;
  const [side, setSide] = useState<ListSide>("bottom");

  useLayoutEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const choose = (): void => {
      setSide(listSideFor(input.current));
    };
    choose();
    window.addEventListener("resize", choose);
    window.visualViewport?.addEventListener("resize", choose);
    return () => {
      window.removeEventListener("resize", choose);
      window.visualViewport?.removeEventListener("resize", choose);
    };
  }, [isOpen, input]);

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
          if (!scrolling.current) {
            comboBox.close();
          }
        },
      }}
    >
      <Popover {...props} placement={`${side} start`} shouldFlip={false} />
    </OverlayTriggerStateContext.Provider>
  );
}
