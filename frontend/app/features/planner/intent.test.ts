import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntentGate, plannerMayLoad, type IntentGate } from "./intent";

/** The prerendered planner, as far as the gate cares: a panel with a form, buttons and segments. */
function mountIsland(): {
  island: HTMLElement;
  panel: HTMLElement;
  form: HTMLFormElement;
  origin: HTMLInputElement;
  swap: HTMLButtonElement;
  stepper: HTMLButtonElement;
  submit: HTMLButtonElement;
  link: HTMLAnchorElement;
  radio: HTMLInputElement;
  segment: HTMLElement;
  outside: HTMLButtonElement;
} {
  document.body.innerHTML = [
    '<button id="outside">Theme</button>',
    "<div data-planner-island>",
    "  <section data-planner-panel>",
    "    <form novalidate>",
    '      <input id="origin" role="combobox" />',
    '      <button id="swap" type="button">Swap</button>',
    '      <button id="stepper" type="button">Increase</button>',
    '      <input id="radio" type="radio" name="interval" value="10" />',
    '      <span id="segment" role="spinbutton" contenteditable="true">10</span>',
    '      <button id="submit" type="submit">Plan routes</button>',
    "    </form>",
    '    <a id="link" href="/methodology">Methodology</a>',
    "  </section>",
    "</div>",
  ].join("\n");
  const get = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`#${id} is missing`);
    return node;
  };
  const island = document.querySelector<HTMLElement>("[data-planner-island]");
  const panel = document.querySelector<HTMLElement>("[data-planner-panel]");
  const form = document.querySelector("form");
  if (island === null || panel === null || form === null) throw new Error("fixture is missing");
  return {
    island,
    panel,
    form,
    origin: get("origin") as HTMLInputElement,
    swap: get("swap") as HTMLButtonElement,
    stepper: get("stepper") as HTMLButtonElement,
    submit: get("submit") as HTMLButtonElement,
    link: get("link") as HTMLAnchorElement,
    radio: get("radio") as HTMLInputElement,
    segment: get("segment"),
    outside: get("outside") as HTMLButtonElement,
  };
}

function fire(target: EventTarget, type: string, init: EventInit = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** Whether the promise has settled, without waiting for it. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

let gate: IntentGate;
let dom: ReturnType<typeof mountIsland>;

beforeEach(() => {
  dom = mountIsland();
  gate = createIntentGate(document);
});

afterEach(() => {
  gate.dispose();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("what counts as intent", () => {
  it.each(["pointerdown", "touchstart", "keydown", "focusin"])(
    "a %s anywhere on the page asks for the planner",
    async (type) => {
      expect(await settled(gate.intent)).toBe(false);

      fire(dom.outside, type);

      expect(await settled(gate.intent)).toBe(true);
    },
  );

  it("pointer movement over the planner panel asks for it", async () => {
    fire(dom.panel, "pointermove");

    expect(await settled(gate.intent)).toBe(true);
  });

  it("pointer movement elsewhere on the page does not", async () => {
    fire(dom.outside, "pointermove");
    fire(dom.outside, "pointerover");

    expect(await settled(gate.intent)).toBe(false);
  });

  it("nothing else does: not a load, a visibility change, a scroll or the passing of time", async () => {
    vi.useFakeTimers();

    fire(document, "visibilitychange");
    fire(window, "load");
    fire(document, "scroll");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settled(gate.intent)).toBe(false);
  });
});

describe("the busy state", () => {
  it("shows at once when the visitor presses something inside the planner", () => {
    fire(dom.origin, "pointerdown");

    expect(dom.form.getAttribute("aria-busy")).toBe("true");
    expect(dom.island.hasAttribute("data-busy")).toBe(true);
  });

  it("shows for a key press inside the planner", () => {
    key(dom.origin, "a");

    expect(dom.form.getAttribute("aria-busy")).toBe("true");
  });

  it("shows for focus inside the planner", () => {
    fire(dom.origin, "focusin");

    expect(dom.form.getAttribute("aria-busy")).toBe("true");
  });

  it("does not show for hover alone", () => {
    fire(dom.panel, "pointermove");
    fire(dom.origin, "pointerover");

    expect(dom.form.hasAttribute("aria-busy")).toBe(false);
    expect(dom.island.hasAttribute("data-busy")).toBe(false);
  });

  it("does not show for input elsewhere on the page", () => {
    fire(dom.outside, "pointerdown");

    expect(dom.form.hasAttribute("aria-busy")).toBe(false);
  });

  it("goes away when the planner is alive", () => {
    fire(dom.origin, "pointerdown");

    gate.release();

    expect(dom.form.hasAttribute("aria-busy")).toBe(false);
    expect(dom.island.hasAttribute("data-busy")).toBe(false);
  });
});

describe("a submit before the planner is alive", () => {
  it("is held back: no native submission, and it is remembered once", () => {
    const first = fire(dom.form, "submit");
    const second = fire(dom.form, "submit");

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(gate.take().submitted).toBe(true);
    expect(gate.take().submitted).toBe(false);
  });

  it("shows the busy state", () => {
    fire(dom.form, "submit");

    expect(dom.form.getAttribute("aria-busy")).toBe("true");
  });

  it("is the form's own again once the planner is alive", () => {
    gate.release();

    expect(fire(dom.form, "submit").defaultPrevented).toBe(false);
    expect(gate.take().submitted).toBe(false);
  });
});

describe("a press before the planner is alive", () => {
  it("is remembered, in order, for each button of the planner", () => {
    fire(dom.swap, "click");
    fire(dom.stepper, "click");
    fire(dom.swap, "click");

    expect(gate.take().activations).toEqual([dom.swap, dom.stepper, dom.swap]);
  });

  it("is remembered for the button that holds an icon, whatever inside it is pressed", () => {
    dom.swap.innerHTML = '<svg id="icon"></svg>';
    const icon = document.getElementById("icon");
    if (icon === null) throw new Error("icon is missing");

    fire(icon, "click");

    expect(gate.take().activations).toEqual([dom.swap]);
  });

  it("is left alone for a link, which navigates as it always did", () => {
    const click = fire(dom.link, "click");

    expect(gate.take().activations).toEqual([]);
    expect(click.defaultPrevented).toBe(false);
  });

  it("is left alone for a radio, whose chosen state the page keeps by itself", () => {
    fire(dom.radio, "click");

    expect(gate.take().activations).toEqual([]);
  });

  it("is not remembered for the submit button: the submit it causes is", () => {
    fire(dom.submit, "click");

    expect(gate.take().activations).toEqual([]);
  });

  it("is not remembered outside the planner", () => {
    fire(dom.outside, "click");

    expect(gate.take().activations).toEqual([]);
  });

  it("is not remembered once the planner is alive", () => {
    gate.release();

    fire(dom.swap, "click");

    expect(gate.take().activations).toEqual([]);
  });

  it("is handed over once", () => {
    fire(dom.swap, "click");

    expect(gate.take().activations).toHaveLength(1);
    expect(gate.take().activations).toHaveLength(0);
  });
});

describe("keys that need the planner's code", () => {
  it.each(["1", "a", "Backspace", "Delete", "ArrowUp", "ArrowDown", "Enter", " "])(
    "%s in a date or time segment is held back while the planner loads",
    (name) => {
      const event = key(dom.segment, name);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it.each(["Tab", "Escape"])("%s still moves the visitor on", (name) => {
    expect(key(dom.segment, name).defaultPrevented).toBe(false);
  });

  it("a shortcut with Control or Meta is left to the browser", () => {
    expect(key(dom.segment, "c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(dom.segment, "v", { metaKey: true }).defaultPrevented).toBe(false);
  });

  it("text typed into a plain input is the browser's own: the planner adopts it when it wakes", () => {
    expect(key(dom.origin, "a").defaultPrevented).toBe(false);
  });

  it("edits of a segment that do not come from a key are held back too", () => {
    for (const type of ["beforeinput", "paste", "drop", "cut"]) {
      expect(fire(dom.segment, type).defaultPrevented, type).toBe(true);
    }
  });

  it("everything is the page's own again once the planner is alive", () => {
    gate.release();

    expect(key(dom.segment, "1").defaultPrevented).toBe(false);
    expect(fire(dom.segment, "beforeinput").defaultPrevented).toBe(false);
  });
});

describe("dispose", () => {
  it("stops listening", async () => {
    gate.dispose();

    fire(dom.origin, "pointerdown");
    fire(dom.form, "submit");

    expect(await settled(gate.intent)).toBe(false);
    expect(dom.form.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("plannerMayLoad", () => {
  const waiting = new Promise<void>(() => undefined);
  const gateWaiting = { intent: waiting };

  it("waits for the visitor on the prerendered page", () => {
    const decision = plannerMayLoad({ gate: gateWaiting, island: true, search: "" });

    expect(decision).toBe(waiting);
  });

  it("does not wait for a shared link: a trip or a plan in the address is a visitor who came to use it", async () => {
    const decision = plannerMayLoad({ gate: gateWaiting, island: true, search: "?plan=pln_01" });

    expect(await settled(decision)).toBe(true);
  });

  it("does not wait when the page was reached by navigating inside the app", async () => {
    const decision = plannerMayLoad({ gate: gateWaiting, island: false, search: "" });

    expect(await settled(decision)).toBe(true);
  });

  it("does not wait where there is no browser (the prerender)", async () => {
    const decision = plannerMayLoad({ gate: null, island: false, search: "" });

    expect(await settled(decision)).toBe(true);
  });
});
