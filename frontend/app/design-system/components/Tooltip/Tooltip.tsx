import { useState } from "react";
import type { ReactElement } from "react";
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
  return (
    <TooltipTrigger delay={delay} isDisabled={isDisabled} isOpen={isOpen} onOpenChange={setIsOpen}>
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
