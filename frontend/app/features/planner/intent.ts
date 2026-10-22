/**
 * Intent-gated hydration of the planner (ADR 0007): the code of the planner loads when the visitor
 * first gives the page a direct input, not when the page loads (N1). Until it has loaded, the
 * prerendered form is plain HTML. This module is the part that stays in the first download: it
 * listens for the input, shows that the page heard it, and keeps what the visitor did from being
 * lost or doing harm until the planner is alive.
 *
 * It is plain DOM, with no React, no component library and no schema library: its size is part of
 * the budget it exists to protect.
 *
 * What it keeps, and why:
 * - A press on a button has no effect on a page nobody has hydrated, so the button is remembered and
 *   pressed again, once, when the planner is alive.
 * - A submit would reload the page with the form's values in the address (the form has no action),
 *   so it is held back and remembered, and the form's own handler runs it later.
 * - Text typed into an input stays in the input: the planner reads it when it wakes.
 * - A date or time segment is an editable span that only the planner's code knows how to edit, so
 *   edits of it are held back while the busy state shows.
 */

/** The element that holds the whole prerendered planner. */
export const ISLAND_SELECTOR = "[data-planner-island]";
const ISLAND = ISLAND_SELECTOR;
/** The side panel or sheet: moving the pointer over it is a sign the visitor is about to use it. */
const PANEL = "[data-planner-panel]";
/** The editable spans of the date and time fields. */
const SEGMENT = '[contenteditable]:not([contenteditable="false"])';
/** Keys that move the visitor on and never edit anything. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["Tab", "Escape", "Shift"]);

/** What the visitor did to the prerendered planner while its code was on the way. */
export interface EarlyInput {
  /** The buttons that were pressed, in order. */
  readonly activations: readonly HTMLElement[];
  /** Whether the form was submitted (Enter in a field, or the submit button). */
  readonly submitted: boolean;
}

/** The listener behind {@link createIntentGate}. */
export interface IntentGate {
  /** Settles the first time the visitor gives the page a direct input. */
  readonly intent: Promise<void>;
  /** Hands over what the visitor did meanwhile, once: the record is empty afterwards. */
  take(): EarlyInput;
  /** The planner is alive: stop holding input back, forget the record and clear the busy state. */
  release(): void;
  /** Removes every listener. */
  dispose(): void;
}

/** The part of a gate that decides whether the planner's code may load yet. */
export interface IntentSource {
  readonly intent: Promise<void>;
}

function closest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

/**
 * Starts listening on a document.
 *
 * @param doc - The page.
 */
export function createIntentGate(doc: Document): IntentGate {
  let alive = false;
  let submitted = false;
  let activations: HTMLElement[] = [];
  let wake!: () => void;
  const intent = new Promise<void>((resolve) => {
    wake = resolve;
  });

  /** Shows that the planner heard the visitor: the form is busy until the code arrives. */
  function showBusy(island: Element): void {
    island.setAttribute("data-busy", "");
    island.querySelector("form")?.setAttribute("aria-busy", "true");
  }

  function clearBusy(): void {
    for (const island of doc.querySelectorAll(ISLAND)) {
      island.removeAttribute("data-busy");
      island.querySelector("form")?.removeAttribute("aria-busy");
    }
  }

  const onInput = (event: Event): void => {
    wake();
    const island = alive ? null : closest(event.target, ISLAND);
    if (island !== null) showBusy(island);
  };

  const onHover = (event: Event): void => {
    if (closest(event.target, PANEL) !== null) wake();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    onInput(event);
    if (alive || closest(event.target, SEGMENT) === null) return;
    if (event.ctrlKey || event.metaKey || event.altKey || NAVIGATION_KEYS.has(event.key)) return;
    event.preventDefault();
  };

  /** Edits that arrive without a key (paste, drop, cut, input methods) are held back the same way. */
  const onEdit = (event: Event): void => {
    if (!alive && closest(event.target, SEGMENT) !== null) event.preventDefault();
  };

  const onSubmit = (event: Event): void => {
    const island = alive ? null : closest(event.target, ISLAND);
    if (island === null) return;
    event.preventDefault();
    submitted = true;
    wake();
    showBusy(island);
  };

  const onClick = (event: Event): void => {
    if (alive) return;
    const button = closest(event.target, "button");
    if (!(button instanceof HTMLButtonElement) || closest(button, ISLAND) === null) return;
    // The submit button's press is remembered as the submit it causes.
    if (button.type !== "submit") activations.push(button);
  };

  const listeners: [string, EventListener][] = [
    ["pointerdown", onInput],
    ["touchstart", onInput],
    ["focusin", onInput],
    ["keydown", onKeydown as EventListener],
    ["pointermove", onHover],
    ["pointerover", onHover],
    ["beforeinput", onEdit],
    ["paste", onEdit],
    ["drop", onEdit],
    ["cut", onEdit],
    ["submit", onSubmit],
    ["click", onClick],
  ];
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);

  return {
    intent,
    take() {
      const early = { activations, submitted };
      activations = [];
      submitted = false;
      return early;
    },
    release() {
      alive = true;
      activations = [];
      submitted = false;
      clearBusy();
    },
    dispose() {
      for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true);
    },
  };
}

/** What the loader of the planner's code needs to know to decide. */
export interface LoadContext {
  /** The page's gate; `null` where there is no browser (the prerender). */
  readonly gate: IntentSource | null;
  /** Whether the prerendered planner is on the page, waiting to be hydrated. */
  readonly island: boolean;
  /** The address's query string. */
  readonly search: string;
}

/**
 * Settles when the planner's code may load. It waits for the visitor on the prerendered page, and
 * only there: a shared link (a trip or a plan in the address) is a visitor who came to use the
 * planner, a visit that arrives by navigating inside the app has already given its input, and the
 * prerender has no visitor at all.
 */
export function plannerMayLoad({ gate, island, search }: LoadContext): Promise<void> {
  return gate === null || !island || search !== "" ? Promise.resolve() : gate.intent;
}
