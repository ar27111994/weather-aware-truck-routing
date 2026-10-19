import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { I18nProvider } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { NumberField, type NumberFieldProps } from "./NumberField";
import NumberFieldDemo from "./NumberField.demo";

const load = copy.form.load;

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

    await user.clear(input);
    await user.type(input, "-5");
    await user.tab();
    expect(input).toHaveValue("0");
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
    function Live(): ReactElement {
      const [value, setValue] = useState(0);
      return (
        <LoadField
          value={value}
          onChange={setValue}
          description={value >= 45000 ? load.hint.lr2 : load.hint.none}
        />
      );
    }
    render(<Live />);
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
    function Controlled(): ReactElement {
      const [value, setValue] = useState(1000);
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
      const { container } = render(<NumberFieldDemo />);

      await expectNoAxeViolations(container);
    });
  });

  describe("demo", () => {
    it("lets the preset buttons and the live hint work", async () => {
      const user = userEvent.setup();
      render(<NumberFieldDemo />);

      await user.click(screen.getByRole("button", { name: copy.form.load.presets.p45000 }));

      expect(screen.getAllByRole("textbox", { name: load.label })[0]).toHaveValue("45,000");
      expect(screen.getByText(load.hint.lr2)).toBeInTheDocument();
    });
  });
});
