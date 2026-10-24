import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { NumberField, type NumberFieldProps } from "./NumberField";
import { demo } from "./NumberField.demo";

const load = {
  label: t("form.load.label"),
  unit: t("form.load.unit"),
  decrement: t("form.load.decrement"),
  increment: t("form.load.increment"),
  presetsLabel: t("form.load.presetsLabel"),
  hint: { none: t("form.load.hint.none"), lr2: t("form.load.hint.lr2") },
  error: { range: t("form.load.error.range"), integer: t("form.load.error.integer") },
} as const;

/** React Aria names a stepper by the caller's label followed by the field's label. */
function stepper(label: string): HTMLElement {
  return screen.getByRole("button", { name: `${label} ${load.label}` });
}

function LoadField(props: Partial<NumberFieldProps> = {}): ReactElement {
  return (
    <I18nProvider locale="en-US">
      <NumberField
        label={load.label}
        unit={load.unit}
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

describe("NumberField", () => {
  it("names the spin button by its label and the steppers by the caller's labels", () => {
    render(<LoadField />);

    expect(screen.getByRole("textbox", { name: load.label })).toBeInTheDocument();
    expect(stepper(load.decrement)).toBeInTheDocument();
    expect(stepper(load.increment)).toBeInTheDocument();
  });

  it("lets screen readers hear the unit through the accessible description", () => {
    render(<LoadField description="Hint text" />);

    expect(screen.getByRole("textbox", { name: load.label })).toHaveAccessibleDescription(
      `Hint text ${load.unit}`,
    );
  });

  it("describes the unit even without a hint", () => {
    render(<LoadField />);

    expect(screen.getByRole("textbox", { name: load.label })).toHaveAccessibleDescription(
      load.unit,
    );
  });

  it("works without a unit", () => {
    render(
      <NumberField
        label={load.label}
        decrementLabel={load.decrement}
        incrementLabel={load.increment}
      />,
    );

    expect(screen.getByRole("textbox", { name: load.label })).not.toHaveAccessibleDescription();
  });

  it("formats the value with grouping and commits typed input on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LoadField onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.type(input, "38000");
    await user.tab();

    expect(input).toHaveValue("38,000");
    expect(onChange).toHaveBeenLastCalledWith(38000);
  });

  it("steps with the buttons by the step size", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={38000} />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.click(stepper(load.increment));
    expect(input).toHaveValue("39,000");
    await user.click(stepper(load.decrement));
    await user.click(stepper(load.decrement));

    expect(input).toHaveValue("37,000");
  });

  it("clamps to the minimum and maximum when typing", async () => {
    const user = userEvent.setup();
    render(<LoadField />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.type(input, "95000");
    await user.tab();
    expect(input).toHaveValue("80,000");
  });

  // The old assertion typed "-5" and expected "0": React Aria refuses the minus sign when the
  // minimum is not negative, so the field held "5", and only the snap to a step of 1,000 turned it
  // into 0. Typing is not snapped any more (R3-02), so the lower limit is tested with a limit above 0.
  it("raises a typed value that is below the minimum to the minimum", async () => {
    const user = userEvent.setup();
    render(<LoadField minValue={1000} />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.type(input, "500");
    await user.tab();

    expect(input).toHaveValue("1,000");
  });

  it("disables a stepper at its limit", () => {
    render(<LoadField defaultValue={80000} />);

    expect(stepper(load.increment)).toBeDisabled();
    expect(stepper(load.decrement)).toBeEnabled();
  });

  it("supports arrow, page, home and end keys", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={38000} />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("39,000");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input).toHaveValue("37,000");
    await user.keyboard("{PageUp}");
    expect(input).toHaveValue("38,000");
    await user.keyboard("{End}");
    expect(input).toHaveValue("80,000");
    await user.keyboard("{Home}");
    expect(input).toHaveValue("0");
  });

  it("groups digits by the user's locale", () => {
    render(
      <I18nProvider locale="de-DE">
        <NumberField
          label={load.label}
          decrementLabel={load.decrement}
          incrementLabel={load.increment}
          defaultValue={38000}
          formatOptions={{ maximumFractionDigits: 0, useGrouping: true }}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("textbox", { name: load.label })).toHaveValue("38.000");
  });

  it("announces the hint politely and updates it as the value changes", async () => {
    const user = userEvent.setup();
    render(
      <Controlled<number> initial={0}>
        {({ value, onChange }) => (
          <LoadField
            value={value}
            onChange={onChange}
            description={value >= 45000 ? load.hint.lr2 : load.hint.none}
          />
        )}
      </Controlled>,
    );
    const hint = screen.getByText(load.hint.none);
    expect(hint).toHaveAttribute("aria-live", "polite");

    await user.click(screen.getByRole("textbox", { name: load.label }));
    await user.keyboard("{End}");

    expect(screen.getByText(load.hint.lr2)).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(load.hint.lr2)).toBe(hint);
  });

  it("renders the presets slot between the control and the hint", () => {
    render(
      <LoadField
        description="Hint text"
        presets={<div data-testid="presets">{load.presetsLabel}</div>}
      />,
    );

    const presets = screen.getByTestId("presets");
    const hint = screen.getByText("Hint text");
    expect(presets.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: load.label }).compareDocumentPosition(presets) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no error while valid, and shows it with an invalid state when invalid", () => {
    const { rerender } = render(<LoadField errorMessage={load.error.range} />);
    const input = screen.getByRole("textbox", { name: load.label });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(load.error.range)).not.toBeInTheDocument();

    rerender(<LoadField errorMessage={load.error.range} isInvalid />);

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(load.error.range)).toBeVisible();
    expect(input).toHaveAccessibleDescription(new RegExp(load.error.range));
  });

  it("flags a failing validate function with the computed error", async () => {
    const user = userEvent.setup();
    render(
      <LoadField step={1} validate={(value) => (value % 1000 === 0 ? null : load.error.integer)} />,
    );

    await user.type(screen.getByRole("textbox", { name: load.label }), "1500");
    await user.tab();

    expect(screen.getByText(load.error.integer)).toBeInTheDocument();
  });

  it("works controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<number> initial={1000} onChange={onChange}>
        {({ value, onChange: change }) => <LoadField value={value} onChange={change} />}
      </Controlled>,
    );

    await user.click(stepper(load.increment));

    expect(onChange).toHaveBeenCalledWith(2000);
    expect(screen.getByRole("textbox", { name: load.label })).toHaveValue("2,000");
  });

  it("is disabled as a whole", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={1000} isDisabled />);

    await user.click(stepper(load.increment));

    expect(screen.getByRole("textbox", { name: load.label })).toBeDisabled();
    expect(stepper(load.increment)).toBeDisabled();
    expect(screen.getByRole("textbox", { name: load.label })).toHaveValue("1,000");
  });

  it("cannot be edited while read only", async () => {
    const user = userEvent.setup();
    render(<LoadField defaultValue={1000} isReadOnly />);
    const input = screen.getByRole("textbox", { name: load.label });

    await user.type(input, "5");
    await user.click(stepper(load.increment));

    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("1,000");
  });

  it("passes name and required through", () => {
    render(<LoadField name="load" isRequired />);

    const input = screen.getByRole("textbox", { name: new RegExp(load.label) });
    expect(input).toBeRequired();
    expect(document.querySelector('input[name="load"]')).toBeInTheDocument();
  });

  describe("interaction states", () => {
    /** React Aria's Group, the bordered box: it wears the field's hover and its ring. */
    const box = (): HTMLElement => screen.getByRole("group");
    const input = (): HTMLElement => screen.getByRole("textbox", { name: load.label });
    const steppers = [
      ["decrease", load.decrement],
      ["increase", load.increment],
    ] as const;

    it("hovers the box while the pointer rests on the input", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await expectHoverState(user, input(), box());
    });

    it.each(steppers)(
      "hovers the %s stepper while the pointer rests on it",
      async (_name, label) => {
        const user = userEvent.setup();
        render(<LoadField defaultValue={38000} />);

        await expectHoverState(user, stepper(label));
      },
    );

    it.each(steppers)(
      "presses the %s stepper while a pointer button is held down on it",
      async (_name, label) => {
        const user = userEvent.setup();
        render(<LoadField defaultValue={38000} />);

        await expectPressedState(user, stepper(label));
      },
    );

    it("rings the box when the keyboard puts focus in the input", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await expectKeyboardFocusState(user, input(), box());
    });

    it("rings the box through focus-within when a click puts focus in the input", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await user.click(input());

      expect(input()).toHaveFocus();
      expect(box()).toHaveAttribute("data-focus-within", "true");
    });

    it("moves focus into the input, and so rings the box, when a stepper is pressed", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await user.click(stepper(load.increment));

      expect(input()).toHaveFocus();
      expect(box()).toHaveAttribute("data-focus-within", "true");
    });

    it("keeps the steppers out of the tab order, so the first Tab reaches the input", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} />);

      await user.tab();

      expect(input()).toHaveFocus();
      expect(stepper(load.decrement)).toHaveAttribute("tabindex", "-1");
      expect(stepper(load.increment)).toHaveAttribute("tabindex", "-1");
    });

    it("is neither hovered nor pressed on the box while disabled", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} isDisabled />);

      await expectNoPointerStates(user, input(), box());
    });

    it.each(steppers)(
      "is neither hovered nor pressed on the %s stepper while disabled",
      async (_name, label) => {
        const user = userEvent.setup();
        render(<LoadField defaultValue={38000} isDisabled />);

        await expectNoPointerStates(user, stepper(label));
      },
    );

    it.each([
      ["increase", load.increment, 80000],
      ["decrease", load.decrement, 0],
    ] as const)(
      "is neither hovered nor pressed on the %s stepper at its limit",
      async (_name, label, limit) => {
        const user = userEvent.setup();
        render(<LoadField defaultValue={limit} />);

        await expectNoPointerStates(user, stepper(label));
      },
    );

    it.each(steppers)(
      "is neither hovered nor pressed on the %s stepper while read only",
      async (_name, label) => {
        const user = userEvent.setup();
        render(<LoadField defaultValue={38000} isReadOnly />);

        await expectNoPointerStates(user, stepper(label));
      },
    );

    it("rings the box when the keyboard puts focus in the input while read only", async () => {
      const user = userEvent.setup();
      render(<LoadField defaultValue={38000} isReadOnly />);

      await expectKeyboardFocusState(user, input(), box());
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations in several states", async () => {
      const { container } = render(
        <>
          <LoadField description="Hint" presets={<span>Presets</span>} />
          <LoadField isInvalid errorMessage="Bad" />
          <LoadField isDisabled />
          <LoadField isReadOnly />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = render(<>{demo.states[0]?.node}</>);

      await expectNoAxeViolations(container);
    });
  });

  describe("demo", () => {
    it("draws the presets as toggle chips and presses the one that matches the value", async () => {
      const user = userEvent.setup();
      render(<>{demo.states[0]?.node}</>);

      const p38000 = screen.getByRole("button", { name: t("form.load.presets.p38000") });
      const p45000 = screen.getByRole("button", { name: t("form.load.presets.p45000") });
      expect(p38000).toHaveAttribute("aria-pressed", "true");
      expect(p45000).toHaveAttribute("aria-pressed", "false");

      await user.click(p45000);

      expect(p45000).toHaveAttribute("aria-pressed", "true");
      expect(p38000).toHaveAttribute("aria-pressed", "false");
    });

    it("lets the preset buttons and the live hint work", async () => {
      const user = userEvent.setup();
      render(<>{demo.states[0]?.node}</>);

      await user.click(screen.getByRole("button", { name: t("form.load.presets.p45000") }));

      expect(screen.getAllByRole("textbox", { name: load.label })[0]).toHaveValue("45,000");
      expect(screen.getByText(load.hint.lr2)).toBeInTheDocument();
    });
  });
});
