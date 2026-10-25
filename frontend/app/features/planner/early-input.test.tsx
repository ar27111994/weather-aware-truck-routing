import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "./departure";
import { createEarlyInputSource, useEarlyInput, type EarlyInputSource } from "./early-input";
import type { IntentGate } from "./intent";
import { usePlannerForm } from "./usePlannerForm";

const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };

/** What the visitor did, as the gate will hand it over. */
interface Early {
  /** Called when the planner takes the record: the buttons are in the page by then. */
  readonly buttons?: () => HTMLElement[];
  readonly submitted?: boolean;
}

/** A gate that writes what the planner asks of it into `log`, in order. */
function fakeGate(log: string[], early: Early = {}): IntentGate {
  return {
    intent: Promise.resolve(),
    take() {
      log.push("take");
      return { activations: early.buttons?.() ?? [], submitted: early.submitted ?? false };
    },
    release() {
      log.push("release");
    },
    dispose: () => undefined,
  };
}

/** The planner's form state, a form, and the hook under test, as `PlannerPanel` puts them together. */
function Planner({
  source,
  ready,
  log,
}: {
  source: EarlyInputSource;
  ready: boolean;
  log: string[];
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const form = usePlannerForm({}, ready ? CLOCK : null);
  const [count, setCount] = useState(0);
  useEarlyInput(source, { root, form, ready, locale: "en-US" });
  return (
    <div ref={root}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          log.push("submit");
        }}
      >
        <input
          aria-label="origin"
          value={form.origin.text}
          onChange={(event) => {
            form.setOriginText(event.target.value);
          }}
        />
        <input
          aria-label="load"
          value={Number.isNaN(form.load) ? "" : String(form.load)}
          readOnly
        />
        <input aria-label="interval" value={String(form.interval)} readOnly />
        <button type="button" onClick={() => log.push("A")}>
          A
        </button>
        <button type="button" onClick={() => log.push("B")}>
          B
        </button>
        <button
          type="button"
          onClick={() => {
            setCount(count + 1);
          }}
        >
          Plus one
        </button>
        <output aria-label="count">{count}</output>
        <button type="submit">Go</button>
      </form>
    </div>
  );
}

const button = (name: string): HTMLElement => screen.getByRole("button", { name });

/** A form as the server drew it, with what the visitor typed into it left in its controls. */
function prerenderedForm(typed: {
  origin?: string;
  load?: string;
  interval?: string;
}): HTMLFormElement {
  const form = document.createElement("form");
  form.innerHTML = `
    <div data-early="origin"><input role="combobox" value=""></div>
    <div data-early="destination"><input role="combobox" value=""></div>
    <div data-early="load"><input inputmode="numeric" value=""></div>
    <input type="radio" name="interval" value="10">
    <input type="radio" name="interval" value="25" checked>`;
  const [origin, , load] = Array.from(form.querySelectorAll("input"));
  if (typed.origin !== undefined && origin !== undefined) origin.value = typed.origin;
  if (typed.load !== undefined && load !== undefined) load.value = typed.load;
  if (typed.interval !== undefined) {
    const radio = form.querySelector<HTMLInputElement>(`[type="radio"][value="${typed.interval}"]`);
    if (radio !== null) radio.checked = true;
  }
  return form;
}

describe("useEarlyInput: the visitor's input is handed to the planner once it is alive", () => {
  it("does nothing without a gate (the prerender, a page nobody listens to)", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(null);
    const view = render(<Planner source={source} ready={false} log={log} />);

    view.rerender(<Planner source={source} ready log={log} />);
    await Promise.resolve();

    expect(log).toEqual([]);
  });

  it("takes the record once for the page, however many panels come and go", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(fakeGate(log));

    const first = render(<Planner key="one" source={source} ready log={log} />);
    first.unmount();
    render(<Planner key="two" source={source} ready log={log} />);
    await waitFor(() => {
      expect(log).toContain("release");
    });

    expect(log.filter((entry) => entry === "take")).toHaveLength(1);
  });

  it("waits for the clock before it puts anything into the form, and then does", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(fakeGate(log));
    source.capture(prerenderedForm({ origin: "Salt", load: "38,000", interval: "10" }));
    const view = render(<Planner source={source} ready={false} log={log} />);

    expect(screen.getByLabelText("origin")).toHaveValue("");
    expect(screen.getByLabelText("interval")).toHaveValue("25");

    view.rerender(<Planner source={source} ready log={log} />);

    expect(screen.getByLabelText("origin")).toHaveValue("Salt");
    expect(screen.getByLabelText("load")).toHaveValue("38000");
    expect(screen.getByLabelText("interval")).toHaveValue("10");
    await waitFor(() => {
      expect(log).toEqual(["take", "release"]);
    });
  });

  it("presses the buttons the visitor pressed, in order, once each, and then lets the page go", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(
      fakeGate(log, { buttons: () => [button("B"), button("A"), button("B")] }),
    );

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(log).toEqual(["take", "B", "A", "B", "release"]);
    });
  });

  it("lets every press see what the one before it left: a button pressed twice is pressed twice", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(
      fakeGate(log, { buttons: () => [button("Plus one"), button("Plus one")] }),
    );

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(screen.getByLabelText("count")).toHaveTextContent("2");
    });
  });

  it("runs the submit the visitor made once, after the page is let go (the gate would hold it back)", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(fakeGate(log, { submitted: true }));

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(log).toEqual(["take", "release", "submit"]);
    });
  });

  it("presses before it submits: a press that changes the form comes first", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(
      fakeGate(log, { buttons: () => [button("A")], submitted: true }),
    );

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(log).toEqual(["take", "A", "release", "submit"]);
    });
  });

  it("skips a button that is no longer in the page (the panel was rebuilt)", async () => {
    const log: string[] = [];
    const gone = document.createElement("button");
    gone.addEventListener("click", () => log.push("gone"));
    const source = createEarlyInputSource(fakeGate(log, { buttons: () => [gone, button("A")] }));

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(log).toEqual(["take", "A", "release"]);
    });
  });

  it("lets the page go even when the visitor did nothing", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(fakeGate(log));

    render(<Planner source={source} ready log={log} />);

    await waitFor(() => {
      expect(log).toEqual(["take", "release"]);
    });
  });

  it("hands the input to the panel that is alive when the clock comes, not to one that was replaced", async () => {
    const log: string[] = [];
    const source = createEarlyInputSource(fakeGate(log));
    source.capture(prerenderedForm({ origin: "Salt" }));
    const first = render(<Planner key="one" source={source} ready={false} log={log} />);
    first.unmount();

    render(<Planner key="two" source={source} ready log={log} />);

    expect(screen.getByLabelText("origin")).toHaveValue("Salt");
    await waitFor(() => {
      expect(log).toEqual(["take", "release"]);
    });
  });

  it("reads nothing where there is no panel to read", () => {
    const capture = vi.fn();
    const source: EarlyInputSource = { capture, claim: () => null };

    renderHook(() => {
      const form = usePlannerForm({}, CLOCK);
      useEarlyInput(source, { root: { current: null }, form, ready: false, locale: "en-US" });
    });

    expect(capture).toHaveBeenCalledExactlyOnceWith(null);
  });
});
