import { intervalFromValue } from "./intervals";
import type { PlannerFormState } from "./usePlannerForm";

/**
 * What the visitor did to the prerendered form while the planner's code was on the way (D-46):
 * the text typed into the fields and the checkpoint interval chosen. `null` is a field the visitor
 * did not touch, so a value the page already carries (a shared link's trip) is never overwritten by
 * the empty text the page was drawn with.
 */
export interface EarlyValues {
  readonly origin: string | null;
  readonly destination: string | null;
  readonly load: string | null;
  readonly interval: string | null;
}

/** Nothing was typed or chosen. */
export const NO_EARLY_VALUES: EarlyValues = {
  origin: null,
  destination: null,
  load: null,
  interval: null,
};

/**
 * The fields the visitor can type into before the planner's code arrives. The form marks the root
 * of each with `data-early="<name>"`, and the text is read from the visible input inside it: the
 * reader does not depend on what React Aria draws (the input mode of the load field, the role and
 * the order of the places), so a change there cannot drop what the visitor typed (R4-05).
 */
export type EarlyField = "origin" | "destination" | "load";

/** The visible input of a marked field: React Aria draws a hidden input beside it for the form. */
function inputOf(name: EarlyField): string {
  return `[data-early="${name}"] input:not([type="hidden"])`;
}
/** The checkpoint interval's choices. */
const INTERVAL_CHOSEN = 'input[type="radio"]:checked';

/** The text in an input, if it is not the text the page was drawn with. */
function typedInto(input: HTMLInputElement | null | undefined): string | null {
  return input !== null && input !== undefined && input.value !== input.defaultValue
    ? input.value
    : null;
}

/**
 * Reads what the visitor did to the prerendered form. It reads the document, not React: the form is
 * plain HTML until the planner's code has arrived, and the browser keeps what was typed in it.
 *
 * @param form - The prerendered form; `null` where there is none (a page reached inside the app).
 */
export function readEarlyValues(form: HTMLFormElement | null): EarlyValues {
  if (form === null) return NO_EARLY_VALUES;
  const chosen = form.querySelector<HTMLInputElement>(INTERVAL_CHOSEN);
  return {
    origin: typedInto(form.querySelector<HTMLInputElement>(inputOf("origin"))),
    destination: typedInto(form.querySelector<HTMLInputElement>(inputOf("destination"))),
    load: typedInto(form.querySelector<HTMLInputElement>(inputOf("load"))),
    interval: chosen !== null && !chosen.defaultChecked ? chosen.value : null,
  };
}

/**
 * Pounds from the text typed into the load field, in the visitor's number format ("38,000",
 * "38.000", "38 000"). `NaN` when the text is not a plain non-negative number.
 *
 * @param text - What the field showed.
 * @param locale - The visitor's locale, which says what separates the thousands and the decimals.
 */
export function parseLoadText(text: string, locale: string): number {
  let group = "";
  let decimal = ".";
  for (const part of new Intl.NumberFormat(locale).formatToParts(12_345.6)) {
    if (part.type === "group") group = part.value.replace(/\s/gu, "");
    else if (part.type === "decimal") decimal = part.value;
  }
  let digits = text.replace(/\s/gu, "");
  if (group !== "") digits = digits.replaceAll(group, "");
  digits = digits.replace(decimal, ".");
  return /^\d+(?:\.\d+)?$/u.test(digits) ? Number(digits) : Number.NaN;
}

/**
 * Puts what the visitor did into the form's state, so the next render shows it instead of writing
 * the form's own empty values over it.
 *
 * @param form - The form's state.
 * @param early - What {@link readEarlyValues} found.
 * @param locale - The visitor's locale, for the load.
 */
export function applyEarlyValues(form: PlannerFormState, early: EarlyValues, locale: string): void {
  if (early.origin !== null) form.setOriginText(early.origin);
  if (early.destination !== null) form.setDestinationText(early.destination);
  if (early.load !== null) {
    const pounds = parseLoadText(early.load, locale);
    if (!Number.isNaN(pounds)) form.setLoad(pounds);
  }
  if (early.interval !== null) form.setInterval(intervalFromValue(early.interval));
}
