import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import {
  Button,
  Group,
  I18nProvider,
  Input,
  InputContext,
  NumberField as AriaNumberField,
  NumberFieldStateContext,
} from "react-aria-components";
import { useNumberFieldState } from "react-stately";
import { afterEach, describe, expect, it, vi } from "vitest";

import { elapse, fakeTimerUser, installFakeTimers } from "../../../../test/fake-timers";
import { t } from "../../foundation/strings";
import { NumberField, type NumberFieldProps } from "./NumberField";
import { StepBridge } from "./stepping";

const load = {
  label: t("form.load.label"),
  decrement: t("form.load.decrement"),
  increment: t("form.load.increment"),
} as const;

/** React Aria names a stepper by the caller's label followed by the field's label. */
function stepper(label: string): HTMLElement {
  return screen.getByRole("button", { name: `${label} ${load.label}` });
}

function input(): HTMLElement {
  return screen.getByRole("textbox", { name: load.label });
}

function LoadField(props: Partial<NumberFieldProps> = {}): ReactElement {
  return (
    <I18nProvider locale="en-US">
      <NumberField
        label={load.label}
        decrementLabel={load.decrement}
        incrementLabel={load.increment}
        minValue={0}
        maxValue={80000}
        step={1000}
        formatOptions={{ maximumFractionDigits: 0, useGrouping: true }}
        {...props}
      />
    </I18nProvider>
  );
}

/** A field with no limit and no step of its own: what a caller that sets none gets. */
function BareField(props: Partial<NumberFieldProps> = {}): ReactElement {
  return (
    <I18nProvider locale="en-US">
      <NumberField
        label={load.label}
        decrementLabel={load.decrement}
        incrementLabel={load.increment}
        {...props}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

// R4-06 and R3-02: DESIGN.md says "step 1000 for the steppers (typing allows any integer)".
describe("NumberField typing and stepping", () => {
  it("commits a typed value that is not a multiple of the step exactly as typed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LoadField onChange={onChange} />);

    await user.type(input(), "30400");
    await user.tab();

    expect(input()).toHaveValue("30,400");
    expect(onChange).toHaveBeenLastCalledWith(30400);
  });

  it("shows a controlled value that is off the step as it is", () => {
    render(<LoadField value={30400} onChange={vi.fn()} />);

    expect(input()).toHaveValue("30,400");
  });

  it("shows a default value that is off the step as it is", () => {
    render(<LoadField defaultValue={12345} />);

    expect(input()).toHaveValue("12,345");
  });

  it("steps by exactly the step from a value that is off the step, with the buttons", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={30400} />);

    await user.click(stepper(load.increment));
    expect(input()).toHaveValue("31,400");
    await user.click(stepper(load.decrement));
    await user.click(stepper(load.decrement));

    expect(input()).toHaveValue("29,400");
  });

  it("steps by exactly the step from a value that is off the step, with the arrow and page keys", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={30400} />);

    await user.click(input());
    await user.keyboard("{ArrowUp}");
    expect(input()).toHaveValue("31,400");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input()).toHaveValue("29,400");
    await user.keyboard("{PageUp}");
    expect(input()).toHaveValue("30,400");
    await user.keyboard("{PageDown}");
    expect(input()).toHaveValue("29,400");
  });

  it("steps from the text being typed, before it is committed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LoadField onChange={onChange} />);

    await user.type(input(), "30400");
    await user.click(stepper(load.increment));

    expect(input()).toHaveValue("31,400");
    expect(onChange).toHaveBeenLastCalledWith(31400);
  });

  it("leaves modified arrow keys to the browser and to React Aria", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={30400} />);

    await user.click(input());
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");

    expect(input()).toHaveValue("30,400");
  });

  it("keeps Home, End and Enter with React Aria", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LoadField defaultValue={30400} onChange={onChange} />);

    await user.click(input());
    await user.keyboard("{End}");
    expect(input()).toHaveValue("80,000");
    await user.keyboard("{Home}");
    expect(input()).toHaveValue("0");
    await user.clear(input());
    await user.type(input(), "12345{Enter}");

    expect(input()).toHaveValue("12,345");
    expect(onChange).toHaveBeenLastCalledWith(12345);
  });

  it("stops at the limits and disables the stepper there", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={79500} />);

    await user.click(stepper(load.increment));

    expect(input()).toHaveValue("80,000");
    expect(stepper(load.increment)).toBeDisabled();
    await user.click(stepper(load.decrement));
    expect(input()).toHaveValue("79,000");
  });

  it("clamps the lower limit too", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={500} />);

    await user.click(stepper(load.decrement));

    expect(input()).toHaveValue("0");
    expect(stepper(load.decrement)).toBeDisabled();
  });

  it("starts an empty field from the limit the stepper points away from", async () => {
    const user = userEvent.setup();
    render(<LoadField />);

    await user.click(stepper(load.increment));
    expect(input()).toHaveValue("0");
    await user.clear(input());
    await user.click(stepper(load.decrement));

    expect(input()).toHaveValue("80,000");
  });

  it("starts an empty field without limits from zero", async () => {
    const user = userEvent.setup();
    render(<BareField step={5} />);

    await user.click(stepper(load.increment));
    expect(input()).toHaveValue("0");
    await user.clear(input());
    await user.click(stepper(load.decrement));

    expect(input()).toHaveValue("0");
  });

  it("steps by one when no step is given", async () => {
    const user = userEvent.setup();
    render(<BareField defaultValue={5} />);

    await user.click(stepper(load.increment));

    expect(input()).toHaveValue("6");
  });

  it("does not step a disabled or read-only field", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={38000} isReadOnly />);

    await user.click(input());
    await user.keyboard("{ArrowUp}");

    expect(input()).toHaveValue("38,000");
  });

  it("keeps the steppers out of the tab order and out of the focus on press", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={38000} />);

    await user.click(stepper(load.increment));

    expect(stepper(load.increment)).toHaveAttribute("tabindex", "-1");
    expect(stepper(load.decrement)).toHaveAttribute("tabindex", "-1");
    expect(input()).toHaveFocus();
  });

  describe("holding a stepper down", () => {
    it("steps at once, again after 400 ms, then every 60 ms until the button is released", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<LoadField defaultValue={30400} />);

      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.increment) });
      expect(input()).toHaveValue("31,400");
      await elapse(399);
      expect(input()).toHaveValue("31,400");
      await elapse(1);
      expect(input()).toHaveValue("32,400");
      await elapse(60);
      expect(input()).toHaveValue("33,400");
      await elapse(60);
      expect(input()).toHaveValue("34,400");

      await user.pointer({ keys: "[/MouseLeft]" });
      await elapse(1000);
      expect(input()).toHaveValue("34,400");
    });

    it("stops repeating at the limit", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<LoadField defaultValue={78600} />);

      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.increment) });
      expect(input()).toHaveValue("79,600");
      await elapse(400);
      expect(input()).toHaveValue("80,000");
      // The next tick finds nothing left to step, and the repeat ends.
      await elapse(60);
      await elapse(1000);

      expect(input()).toHaveValue("80,000");
      expect(stepper(load.increment)).toBeDisabled();
      await user.pointer({ keys: "[/MouseLeft]" });
    });

    it("repeats the decrement the same way", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<LoadField defaultValue={38000} />);

      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.decrement) });
      await elapse(400);
      await user.pointer({ keys: "[/MouseLeft]" });

      expect(input()).toHaveValue("36,000");
    });

    it("stops repeating when the field is removed", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      const onChange = vi.fn();
      const { unmount } = render(<LoadField defaultValue={38000} onChange={onChange} />);

      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.increment) });
      unmount();
      const calls = onChange.mock.calls.length;
      await elapse(1000);

      expect(onChange).toHaveBeenCalledTimes(calls);
    });

    it("does not start a second repeat when the press starts again before it ended", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<LoadField defaultValue={38000} />);

      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.increment) });
      await user.pointer({ keys: "[MouseLeft>]", target: stepper(load.decrement) });
      await elapse(400);
      await user.pointer({ keys: "[/MouseLeft]" });
      await elapse(1000);

      // Press 1 stepped up once (39,000), press 2 stepped down once (38,000) and took the repeat
      // over: one more step down after 400 ms. A leaked first timer would keep stepping up.
      expect(input()).toHaveValue("37,000");
    });
  });

  it("ignores the arrow keys while the text is being composed, and at a limit", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={80000} />);

    await user.click(input());
    await user.keyboard("{ArrowUp}");
    expect(input()).toHaveValue("80,000");
    fireEvent.keyDown(input(), { key: "ArrowDown", isComposing: true });

    expect(input()).toHaveValue("80,000");
  });

  it("gives the input the id it is given", () => {
    render(<LoadField id="load-input" />);

    expect(input()).toHaveAttribute("id", "load-input");
  });

  it("moves the focus to the pressed button, not to the field, for a press that is not a mouse click", () => {
    render(<LoadField defaultValue={38000} />);

    fireEvent.click(stepper(load.increment));

    expect(input()).toHaveValue("39,000");
    expect(stepper(load.increment)).toHaveFocus();
  });

  describe("with a finger", () => {
    it("steps once when the finger is lifted from the button", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await user.pointer({ keys: "[TouchA>]", target: stepper(load.increment) });
      expect(input()).toHaveValue("38,000");
      await user.pointer({ keys: "[/TouchA]" });

      expect(input()).toHaveValue("39,000");
    });

    it("repeats after 600 ms, and the lift that ends a repeat does not step again", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<LoadField defaultValue={38000} />);

      await user.pointer({ keys: "[TouchA>]", target: stepper(load.increment) });
      await elapse(599);
      expect(input()).toHaveValue("38,000");
      await elapse(1);
      expect(input()).toHaveValue("39,000");
      await elapse(60);
      expect(input()).toHaveValue("40,000");
      await user.pointer({ keys: "[/TouchA]" });
      await elapse(1000);

      expect(input()).toHaveValue("40,000");
    });
  });

  it("works controlled with a value that is off the step", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Controlled(): ReactElement {
      const [value, setValue] = useState(30400);
      return (
        <LoadField
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Controlled />);

    await user.click(stepper(load.increment));

    expect(onChange).toHaveBeenLastCalledWith(31400);
    expect(input()).toHaveValue("31,400");
  });
});

describe("StepBridge", () => {
  it("refuses to render outside a NumberField", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      render(
        <StepBridge step={1} inputId="x">
          content
        </StepBridge>,
      ),
    ).toThrow(/inside a NumberField/u);

    error.mockRestore();
  });

  it("steps a field whose input it cannot find by id without taking the focus", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en-US">
        <AriaNumberField defaultValue={10} aria-label="Count">
          <StepBridge step={5} inputId="missing">
            <Group>
              <Button slot="decrement">minus</Button>
              <Input />
              <Button slot="increment">plus</Button>
            </Group>
          </StepBridge>
        </AriaNumberField>
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Increase/u }));

    expect(screen.getByRole("textbox")).toHaveValue("15");
  });

  /** A real field state for the bridge, with no input and no buttons of the library around it. */
  function Bare({ children }: { readonly children: ReactElement }): ReactElement {
    const state = useNumberFieldState({ locale: "en-US", defaultValue: 5 });
    return (
      <NumberFieldStateContext.Provider value={state}>
        <StepBridge step={1} inputId="bare">
          {children}
        </StepBridge>
      </NumberFieldStateContext.Provider>
    );
  }

  it("leaves other keys to the input props it finds, when there are none", async () => {
    const user = userEvent.setup();
    render(
      <Bare>
        <Input aria-label="Bare" />
      </Bare>,
    );

    await user.type(screen.getByRole("textbox"), "{Home}x");

    expect(screen.getByRole("textbox")).toHaveValue("x");
  });

  it("leaves other keys to the input props it finds, when they have no key handler", async () => {
    const user = userEvent.setup();
    render(
      <InputContext.Provider value={{}}>
        <Bare>
          <Input aria-label="Bare" />
        </Bare>
      </InputContext.Provider>,
    );

    await user.type(screen.getByRole("textbox"), "{Home}y");

    expect(screen.getByRole("textbox")).toHaveValue("y");
  });
});
