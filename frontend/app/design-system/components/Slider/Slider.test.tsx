import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { defined } from "../../../../test/defined";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { Slider } from "./Slider";

function Controlled({ onChange }: { readonly onChange: (value: number) => void }): ReactElement {
  const [value, setValue] = useState(10);
  return (
    <Slider
      label="Weather"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("Slider", () => {
  it("is a range input named by its label, starting at the minimum", () => {
    render(<Slider label="Departure offset" />);

    const input = screen.getByRole("slider", { name: "Departure offset" });
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100");
    expect(input).toHaveValue("0");
  });

  it("shows the label unless it is hidden, and still names the slider when hidden", () => {
    const { rerender } = render(<Slider label="Departure offset" />);
    expect(screen.getByText("Departure offset")).toBeVisible();

    rerender(<Slider label="Departure offset" isLabelHidden />);

    expect(screen.getByRole("slider", { name: "Departure offset" })).toBeInTheDocument();
    expect(screen.getByText("Departure offset").closest("label")?.parentElement?.className).toMatch(
      /hidden/,
    );
  });

  it("honours min, max, step and the default value", () => {
    render(<Slider label="Hours" minValue={10} maxValue={20} step={2} defaultValue={14} />);

    const input = screen.getByRole("slider");
    expect(input).toHaveAttribute("min", "10");
    expect(input).toHaveAttribute("max", "20");
    expect(input).toHaveAttribute("step", "2");
    expect(input).toHaveValue("14");
  });

  it("moves by the step with the arrow keys and to the ends with Home and End", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Slider label="Hours" maxValue={48} defaultValue={10} onChange={onChange} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("slider")).toHaveValue("11");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("slider")).toHaveValue("9");
    await user.keyboard("{End}");
    expect(screen.getByRole("slider")).toHaveValue("48");
    await user.keyboard("{Home}");
    expect(screen.getByRole("slider")).toHaveValue("0");

    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("pages by a tenth of the range unless it is told otherwise", async () => {
    const user = userEvent.setup();
    render(<Slider label="Hours" defaultValue={50} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{PageUp}");

    expect(screen.getByRole("slider")).toHaveValue("60");
  });

  it("pages by pageStep, and settles with onChangeEnd, when asked to", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <Slider
        label="Hours"
        maxValue={48}
        defaultValue={10}
        pageStep={6}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />,
    );
    screen.getByRole("slider").focus();

    await user.keyboard("{PageUp}");
    expect(screen.getByRole("slider")).toHaveValue("16");
    expect(onChange).toHaveBeenLastCalledWith(16);
    expect(onChangeEnd).toHaveBeenLastCalledWith(16);

    await user.keyboard("{PageDown}{PageDown}");
    expect(screen.getByRole("slider")).toHaveValue("4");
  });

  it("does not let a page jump run past either end", async () => {
    const user = userEvent.setup();
    render(<Slider label="Hours" maxValue={48} defaultValue={46} pageStep={6} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{PageUp}");
    expect(screen.getByRole("slider")).toHaveValue("48");

    await user.keyboard("{Home}{PageDown}");
    expect(screen.getByRole("slider")).toHaveValue("0");
  });

  it("leaves other keys to the slider while a page step is set", async () => {
    const user = userEvent.setup();
    render(<Slider label="Hours" defaultValue={5} pageStep={6} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("slider")).toHaveValue("6");
  });

  it("follows value when controlled and reports each change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith(11);
    expect(screen.getByRole("slider")).toHaveValue("11");
  });

  it("speaks and shows the formatted value", () => {
    render(
      <Slider
        label="Hours"
        defaultValue={6}
        showValue
        formatValue={(hour) => `Tue, +${String(hour)} hours`}
      />,
    );

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue, +6 hours");
    expect(screen.getByRole("status")).toHaveTextContent("Tue, +6 hours");
  });

  it("speaks the plain number by default and shows no output unless asked", () => {
    render(<Slider label="Hours" defaultValue={6} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "6");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cannot be moved while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Slider label="Hours" defaultValue={5} isDisabled onChange={onChange} />);

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("slider")).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws the decoration slots around the track and merges a class name", () => {
    const { container } = render(
      <Slider
        label="Hours"
        className="custom"
        above={<span data-testid="above" />}
        below={<span data-testid="below" />}
      />,
    );

    expect(container.firstElementChild).toHaveClass("custom");
    expect(screen.getByTestId("above")).toBeInTheDocument();
    expect(screen.getByTestId("below")).toBeInTheDocument();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = render(
      <div>
        <Slider label="Plain" />
        <Slider label="With value" showValue defaultValue={30} />
        <Slider label="Hidden label" isLabelHidden />
        <Slider label="Disabled" isDisabled />
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  describe("interaction states", () => {
    /** The thumb is the wrapper around the focused input: it holds the state attributes. */
    function thumbOf(slider: HTMLElement): HTMLElement {
      return defined(slider.closest<HTMLElement>("[data-hovered]"), "the slider's thumb");
    }

    it("hovers the thumb the pointer rests on", async () => {
      const user = userEvent.setup();
      render(<Slider label="Wind threshold" />);

      await expectHoverState(user, thumbOf(screen.getByRole("slider")));
    });

    it("marks the thumb while a pointer button is held down on it, and clears it on release", async () => {
      const user = userEvent.setup();
      render(<Slider label="Wind threshold" />);

      await expectPressedState(
        user,
        thumbOf(screen.getByRole("slider")),
        undefined,
        "data-dragging",
      );
    });

    it("shows the focus ring on the thumb when the keyboard reaches the slider", async () => {
      const user = userEvent.setup();
      render(<Slider label="Wind threshold" />);
      const slider = screen.getByRole("slider");

      await expectKeyboardFocusState(user, slider, thumbOf(slider));
    });

    it("is neither hovered nor dragged while disabled", async () => {
      const user = userEvent.setup();
      render(<Slider label="Wind threshold" isDisabled />);

      await expectNoPointerStates(
        user,
        thumbOf(screen.getByRole("slider")),
        undefined,
        "data-dragging",
      );
    });
  });
});
