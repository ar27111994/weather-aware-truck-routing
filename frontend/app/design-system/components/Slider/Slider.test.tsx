import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import { defined } from "../../../../test/defined";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { Slider } from "./Slider";

/** The thumb is the wrapper around the focused input: it holds the state attributes. */
function thumbOf(slider: HTMLElement): HTMLElement {
  return defined(slider.closest<HTMLElement>("[data-hovered]"), "the slider's thumb");
}

/**
 * jsdom does no layout, so a track measures 0 by 0 and every pointer position would read as 0.
 * Gives the track of this slider the box it would have in a browser: 200 px wide from the left edge.
 */
function measuredTrack(slider: HTMLElement): HTMLElement {
  const track = defined(thumbOf(slider).parentElement, "the slider's track");
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 24));
  return track;
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
    expect(screen.getByText("Departure offset")).toBeInTheDocument();
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
    render(
      <Controlled<number> initial={10} onChange={onChange}>
        {({ value, onChange: change }) => (
          <Slider label="Weather" value={value} onChange={change} />
        )}
      </Controlled>,
    );
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

  it("cannot be moved with the keys while disabled", () => {
    const onChange = vi.fn();
    render(<Slider label="Hours" defaultValue={5} isDisabled onChange={onChange} />);
    const slider = screen.getByRole("slider");

    // A disabled input cannot take focus, so the key goes straight to the element: if the slider
    // listened to it, the value would move.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "End" });

    expect(slider).toBeDisabled();
    expect(slider).toHaveValue("5");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cannot be dragged or clicked into while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Slider label="Hours" defaultValue={5} isDisabled onChange={onChange} />);
    const track = measuredTrack(screen.getByRole("slider"));

    await user.pointer([
      { keys: "[MouseLeft>]", target: track, coords: { clientX: 150, pageX: 150 } },
      { coords: { clientX: 190, pageX: 190 } },
      { keys: "[/MouseLeft]" },
    ]);

    expect(screen.getByRole("slider")).toHaveValue("5");
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("with the pointer (the track measured as 200 px wide)", () => {
    it("jumps to the point of the track that is pressed, and settles there", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onChangeEnd = vi.fn();
      render(<Slider label="Hours" onChange={onChange} onChangeEnd={onChangeEnd} />);
      const track = measuredTrack(screen.getByRole("slider"));

      await user.pointer({
        keys: "[MouseLeft]",
        target: track,
        coords: { clientX: 150, pageX: 150 },
      });

      expect(screen.getByRole("slider")).toHaveValue("75");
      expect(onChange).toHaveBeenLastCalledWith(75);
      expect(onChangeEnd).toHaveBeenLastCalledWith(75);
    });

    it("follows the thumb while it is dragged, marks the drag, and settles on release", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onChangeEnd = vi.fn();
      render(
        <Slider label="Hours" defaultValue={50} onChange={onChange} onChangeEnd={onChangeEnd} />,
      );
      const slider = screen.getByRole("slider");
      const thumb = thumbOf(slider);
      measuredTrack(slider);

      await user.pointer([
        { keys: "[MouseLeft>]", target: thumb, coords: { clientX: 100, pageX: 100 } },
        { coords: { clientX: 140, pageX: 140 } },
      ]);

      expect(thumb).toHaveAttribute("data-dragging", "true");
      expect(slider).toHaveValue("70");
      expect(onChangeEnd).not.toHaveBeenCalled();

      await user.pointer({ keys: "[/MouseLeft]" });

      expect(thumb).toHaveAttribute("data-dragging", "false");
      expect(onChange).toHaveBeenLastCalledWith(70);
      expect(onChangeEnd).toHaveBeenCalledOnce();
      expect(onChangeEnd).toHaveBeenCalledWith(70);
    });

    it("stops at the ends of the track", async () => {
      const user = userEvent.setup();
      render(<Slider label="Hours" defaultValue={90} />);
      const slider = screen.getByRole("slider");
      measuredTrack(slider);

      await user.pointer([
        { keys: "[MouseLeft>]", target: thumbOf(slider), coords: { clientX: 180, pageX: 180 } },
        { coords: { clientX: 400, pageX: 400 } },
        { keys: "[/MouseLeft]" },
      ]);

      expect(slider).toHaveValue("100");
    });
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
