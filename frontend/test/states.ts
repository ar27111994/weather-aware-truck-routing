import type { UserEvent } from "@testing-library/user-event";
import { expect } from "vitest";

/**
 * Interaction states as React Aria reports them. Every component's CSS keys on three `data-*`
 * attributes (DESIGN.md section 10): `data-hovered`, `data-pressed` and `data-focus-visible`. A
 * unit test cannot see paint (jsdom loads no stylesheet; `e2e/states.spec.ts` checks the computed
 * styles in a real browser), so what it proves here is that each state reaches the DOM that the
 * styles read, and leaves it again.
 *
 * `element` is what the user points at or focuses. `carrier` is the element that holds the
 * attribute when that is another one (a slider's thumb wraps the input that takes focus). A state
 * that is on reads `"true"`; off is the attribute absent, or `"false"` where a component writes
 * the boolean itself.
 */

/** The pointer resting on `element` sets `data-hovered`; moving away clears it. */
export async function expectHoverState(
  user: UserEvent,
  element: HTMLElement,
  carrier: HTMLElement = element,
): Promise<void> {
  expect(carrier).not.toHaveAttribute("data-hovered", "true");

  await user.hover(element);
  expect(carrier).toHaveAttribute("data-hovered", "true");

  await user.unhover(element);
  expect(carrier).not.toHaveAttribute("data-hovered", "true");
}

/**
 * A pointer button held down on `element` sets the pressed attribute (`data-pressed`, or
 * `data-dragging` on a slider's thumb); letting go clears it.
 */
export async function expectPressedState(
  user: UserEvent,
  element: HTMLElement,
  carrier: HTMLElement = element,
  attribute = "data-pressed",
): Promise<void> {
  expect(carrier).not.toHaveAttribute(attribute, "true");

  await user.pointer({ keys: "[MouseLeft>]", target: element });
  expect(carrier).toHaveAttribute(attribute, "true");

  await user.pointer({ keys: "[/MouseLeft]" });
  expect(carrier).not.toHaveAttribute(attribute, "true");
}

/**
 * Tab puts focus on `element`, which must be the first tab stop on the page, and the focus ring
 * shows: `data-focus-visible` is the attribute every ring in the CSS keys on.
 */
export async function expectKeyboardFocusState(
  user: UserEvent,
  element: HTMLElement,
  carrier: HTMLElement = element,
): Promise<void> {
  expect(carrier).not.toHaveAttribute("data-focus-visible", "true");

  await user.tab();

  expect(element).toHaveFocus();
  expect(carrier).toHaveAttribute("data-focus-visible", "true");
}

/** A click puts focus on `element` but draws no ring: the ring is for keyboard focus only. */
export async function expectPointerFocusState(
  user: UserEvent,
  element: HTMLElement,
  carrier: HTMLElement = element,
): Promise<void> {
  await user.click(element);

  expect(element).toHaveFocus();
  expect(carrier).not.toHaveAttribute("data-focus-visible", "true");
}

/** A control that cannot be used is never hovered or pressed, so its CSS never has to undo them. */
export async function expectNoPointerStates(
  user: UserEvent,
  element: HTMLElement,
  carrier: HTMLElement = element,
  pressedAttribute = "data-pressed",
): Promise<void> {
  await user.hover(element);
  await user.pointer({ keys: "[MouseLeft>]", target: element });

  expect(carrier).not.toHaveAttribute("data-hovered", "true");
  expect(carrier).not.toHaveAttribute(pressedAttribute, "true");
}
