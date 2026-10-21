import { useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { OverlayArrow, Tooltip as AriaTooltip, TooltipTrigger } from "react-aria-components";

import styles from "./Tooltip.module.css";

/**
 * Hover delay in milliseconds before a tooltip opens. Mirrors `--motion-duration-tooltip-delay`
 * (DESIGN.md section 6); the test suite fails if the two drift apart. Keyboard focus ignores it.
 */
export const TOOLTIP_DELAY_MS = 400;

/** Side of the trigger the tooltip appears on. */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** The tooltip text. It must repeat the trigger's accessible name or visible text, never add to it. */
  readonly content: string;
  /** Exactly one focusable or pressable React Aria element (Button, ToggleButton, Link...). */
  readonly children: ReactElement;
  readonly placement?: TooltipPlacement;
  /** Hover delay in ms; keyboard focus always opens at once. */
  readonly delay?: number;
  readonly isDisabled?: boolean;
  /** Start open (demos and tests); it still closes on Escape, blur and hover end. */
  readonly defaultOpen?: boolean;
}

/**
 * Offset between trigger and tooltip in px. Mirrors `--c-tooltip-offset` (DESIGN.md section 10,
 * Tooltip): the positioning API takes a number, not a custom property, so the test suite fails if
 * the two drift apart.
 */
export const TOOLTIP_OFFSET = 8;

/**
 * Tells whether the browser is in the middle of dispatching a `scroll` event, for as long as that
 * dispatch lasts.
 *
 * React Aria closes an open tooltip from a `scroll` listener that it adds to the window, in the
 * capture phase, when the tooltip opens. Listeners on one target run in the order they were
 * added, so the one added here, when the component mounts, runs first and raises the flag before
 * React Aria's runs. The flag comes down in the next animation frame callback, and the browser
 * dispatches a scroll event as one of the steps of a rendering update, before that update's
 * animation frame callbacks, so nothing else (a key press, a click) can happen in between.
 */
function useScrollDispatch(): RefObject<boolean> {
  const dispatching = useRef(false);
  useEffect(() => {
    const lower = (): void => {
      dispatching.current = false;
    };
    const raise = (): void => {
      dispatching.current = true;
      requestAnimationFrame(lower);
    };
    window.addEventListener("scroll", raise, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", raise, { capture: true });
    };
  }, []);
  return dispatching;
}

/**
 * Short text label for an icon-only or truncated control (DESIGN.md section 10). Opens after the
 * hover delay, at once on keyboard focus, and closes on Escape. Never the only place a fact lives.
 *
 * The open state lives here and is handed to both the trigger and the tooltip. A `Tooltip` that
 * has its own `isOpen` ignores the trigger state's `shouldSkipAnimation`, and that is the point.
 * When focus moves from one trigger to another, React Aria closes the tooltip that is still
 * exiting a second time, "instantly", because the next one opens. The first tooltip is then
 * removed in the middle of its exit animation, its exit state is left at "exiting", and the next
 * render puts it back as an invisible `data-exiting` node that never goes away and stays in the
 * accessibility tree (seen in Chromium, Firefox and WebKit with react-aria 3.53.1 and
 * react-aria-components 1.22.1). jsdom has no animations to interrupt, so `e2e/overlays.spec.ts`
 * is the test.
 *
 * Because the open state lives here, so does the one change this makes to when a tooltip closes.
 * React Aria closes an open tooltip when the page scrolls, since a scroll can carry the trigger
 * away from the pointer. That is the wrong call for a tooltip that keyboard focus opened and that
 * focus still holds. The browser scrolls a trigger that is out of view into view when focus
 * reaches it, and the `scroll` event of that scroll comes after the `focus` event that opened the
 * tooltip, so a keyboard user who tabbed to a trigger below the fold saw its tooltip taken away
 * 25 to 110 ms after it appeared, with focus still on the trigger (seen in Chromium and Firefox
 * with a real Tab, and in WebKit on a loaded machine, where the scroll event arrives later still).
 * WCAG 1.4.13 asks for content that appears on focus to stay until focus leaves or the visitor
 * dismisses it. So a close that arrives inside a scroll event is refused while the element that
 * had focus when the tooltip opened still has it. Escape, blur, a press and the end of a hover are
 * not scroll events and close the tooltip as before, and so does a scroll under a tooltip that a
 * hover opened with nothing focused.
 */
export function Tooltip({
  content,
  children,
  placement = "top",
  delay = TOOLTIP_DELAY_MS,
  isDisabled = false,
  defaultOpen = false,
}: TooltipProps): ReactElement {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const scrolling = useScrollDispatch();
  /** The element that had focus when the tooltip opened, or none when nothing was focused. */
  const focusedAtOpen = useRef<Element | null>(null);

  function handleOpenChange(open: boolean): void {
    if (open) {
      focusedAtOpen.current =
        document.activeElement === document.body ? null : document.activeElement;
    } else if (
      scrolling.current &&
      focusedAtOpen.current !== null &&
      document.activeElement === focusedAtOpen.current
    ) {
      return;
    }
    setIsOpen(open);
  }

  return (
    <TooltipTrigger
      delay={delay}
      isDisabled={isDisabled}
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
    >
      {children}
      <AriaTooltip
        isOpen={isOpen}
        placement={placement}
        offset={TOOLTIP_OFFSET}
        className={styles.tooltip}
      >
        <OverlayArrow className={styles.arrow}>
          <svg viewBox="0 0 8 8" aria-hidden="true">
            <path d="M0 0 L4 4 L8 0" />
          </svg>
        </OverlayArrow>
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
