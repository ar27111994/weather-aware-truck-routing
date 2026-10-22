import { useLayoutEffect, type RefObject } from "react";
import { flushSync } from "react-dom";

import { applyEarlyValues, readEarlyValues, type EarlyValues } from "./early-values";
import type { IntentGate } from "./intent";
import type { PlannerFormState } from "./usePlannerForm";

/**
 * What the visitor did to the prerendered planner while its code was on the way (D-46): the text and
 * choices left in the form, the buttons pressed, and whether the form was submitted.
 */
export interface Handoff {
  readonly gate: IntentGate;
  readonly values: EarlyValues;
  readonly activations: readonly HTMLElement[];
  readonly submitted: boolean;
}

/**
 * One per page. The record is taken from the gate once, by the first panel the page draws, and given
 * to whichever panel is alive when the browser's clock is there: a link that carries a trip starts
 * the panel over once, right after hydration, and the visitor's input must reach the one that stays.
 */
export interface EarlyInputSource {
  /**
   * Takes what the visitor did: the gate's record, and the text and choices left in the prerendered
   * form. Only the first call does anything: later panels find the record already taken.
   */
  capture(form: HTMLFormElement | null): void;
  /** Hands over what {@link capture} took, once; `null` when there is nothing (left) to hand over. */
  claim(): Handoff | null;
}

/** The source of a page: `gate` is `null` where nobody listened to the visitor (the prerender). */
export function createEarlyInputSource(gate: IntentGate | null): EarlyInputSource {
  let captured = false;
  let handoff: Handoff | null = null;
  return {
    capture(form) {
      if (gate === null || captured) return;
      captured = true;
      const { activations, submitted } = gate.take();
      handoff = { gate, values: readEarlyValues(form), activations, submitted };
    },
    claim() {
      const claimed = handoff;
      handoff = null;
      return claimed;
    },
  };
}

/**
 * Does what the visitor asked, once, on a planner that is alive: presses the recorded buttons in
 * order, lets the page go (the gate stops holding input back and its busy marker clears), and last
 * runs the submit through the form's own handler, so that validation and the plan request happen as
 * they would have.
 *
 * Each press is made inside `flushSync`, which draws before it returns, so every press sees the
 * state the one before it left and a press made twice is made twice. Call it from outside React's
 * own work (a microtask is enough), never from an effect or a render.
 *
 * @param handoff - What was taken from the page.
 * @param form - The form to submit; `null` where there is none.
 */
export function replayEarlyInput(
  { gate, activations, submitted }: Handoff,
  form: HTMLFormElement | null,
): void {
  for (const button of activations) {
    // A button of a panel that has been rebuilt since is no longer in the page; its press is moot.
    if (button.isConnected) {
      flushSync(() => {
        button.click();
      });
    }
  }
  gate.release();
  if (submitted) form?.requestSubmit();
}

/** What {@link useEarlyInput} needs from the panel that calls it. */
export interface EarlyInputOptions {
  /** The element around the panel's form. */
  readonly root: RefObject<HTMLElement | null>;
  readonly form: PlannerFormState;
  /** The browser's clock is there: the form is complete and can take what the visitor did. */
  readonly ready: boolean;
  readonly locale: string;
}

/**
 * Hands the planner what the visitor did to the prerendered page while its code was on the way, so
 * that the page keeps what the visitor saw happen and does what the visitor asked, exactly once:
 *
 * 1. At the first commit (the hydration), before anything is drawn again, it reads the text and the
 *    choice left in the form and takes the gate's record of presses. React writes its own state back
 *    into an input the next time it draws it, so this has to come first.
 * 2. When the clock is there (the departure is complete, so a submit can be checked), it puts the
 *    text and the choice into the form's state, and then {@link replayEarlyInput} does the rest.
 *
 * Only public interfaces are used: the document, the controls' own props and the form's submit.
 *
 * @param source - The page's {@link EarlyInputSource}.
 * @param options - The panel's form and its container.
 */
export function useEarlyInput(
  source: EarlyInputSource,
  { root, form, ready, locale }: EarlyInputOptions,
): void {
  useLayoutEffect(() => {
    source.capture(root.current?.querySelector("form") ?? null);
  }, [source, root]);

  useLayoutEffect(() => {
    if (!ready) return;
    const handoff = source.claim();
    if (handoff === null) return;
    applyEarlyValues(form, handoff.values, locale);
    const element = root.current?.querySelector("form") ?? null;
    queueMicrotask(() => {
      replayEarlyInput(handoff, element);
    });
  }, [ready, source, root, form, locale]);
}
