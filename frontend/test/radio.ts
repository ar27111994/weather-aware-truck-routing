import { defined } from "./defined";

/**
 * The element that carries a radio's interaction states. React Aria draws a radio through its
 * `<label>`: `data-hovered`, `data-pressed`, `data-focus-visible`, `data-selected` and
 * `data-disabled` live there, not on the visually hidden `<input type="radio">` that holds focus
 * and the `radio` role (the same split as a Switch, whose row is its label).
 *
 * @param radio - The element with `role="radio"`.
 */
export function radioLabel(radio: HTMLElement): HTMLElement {
  return defined(radio.closest("label"), "the radio's label");
}
