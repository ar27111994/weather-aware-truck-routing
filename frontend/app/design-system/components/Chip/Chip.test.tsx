import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Clock } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { ActionChip, Chip } from "./Chip";

describe("Chip", () => {
  it("is a toggle button that starts unselected", () => {
    render(<Chip>Wind</Chip>);

    const chip = screen.getByRole("button", { name: "Wind" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip).not.toHaveAttribute("data-selected");
  });

  it("toggles on click, Space and Enter when uncontrolled", async () => {
    const user = userEvent.setup();
    render(<Chip>Wind</Chip>);
    const chip = screen.getByRole("button", { name: "Wind" });

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAttribute("data-selected", "true");

    chip.focus();
    await user.keyboard(" ");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await user.keyboard("{Enter}");
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  it("starts selected with defaultSelected", () => {
    render(<Chip defaultSelected>Rain</Chip>);

    expect(screen.getByRole("button", { name: "Rain" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows isSelected and reports changes when controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<boolean> initial={false} onChange={onChange}>
        {({ value, onChange: change }) => (
          <Chip isSelected={value} onChange={change}>
            20,000
          </Chip>
        )}
      </Controlled>,
    );
    const chip = screen.getByRole("button", { name: "20,000" });

    await user.click(chip);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores presses while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Chip isDisabled onChange={onChange}>
        Snow
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "Snow" });

    await user.click(chip);

    expect(onChange).not.toHaveBeenCalled();
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("data-disabled");
  });

  it("shows a leading icon that assistive technology skips", () => {
    render(<Chip leadingIcon={Clock}>Now</Chip>);

    expect(screen.getByRole("button", { name: "Now" }).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("merges a caller class name", () => {
    render(<Chip className="custom">Wind</Chip>);

    expect(screen.getByRole("button")).toHaveClass("custom");
  });

  describe("interaction states", () => {
    it("is hovered while the pointer rests on it", async () => {
      const user = userEvent.setup();
      render(<Chip>Wind</Chip>);

      await expectHoverState(user, screen.getByRole("button", { name: "Wind" }));
    });

    it("is pressed while a pointer button is held down on it", async () => {
      const user = userEvent.setup();
      render(<Chip>Wind</Chip>);

      await expectPressedState(user, screen.getByRole("button", { name: "Wind" }));
    });

    it("shows the focus ring when the keyboard puts focus on it", async () => {
      const user = userEvent.setup();
      render(<Chip>Wind</Chip>);

      await expectKeyboardFocusState(user, screen.getByRole("button", { name: "Wind" }));
    });

    it("shows no focus ring when a click puts focus on it", async () => {
      const user = userEvent.setup();
      render(<Chip>Wind</Chip>);

      await expectPointerFocusState(user, screen.getByRole("button", { name: "Wind" }));
    });

    it("is hovered and pressed while selected, and stays selected", async () => {
      const user = userEvent.setup();
      render(<Chip defaultSelected>Rain</Chip>);
      const chip = screen.getByRole("button", { name: "Rain" });

      await user.hover(chip);
      await user.pointer({ keys: "[MouseLeft>]", target: chip });

      expect(chip).toHaveAttribute("data-selected", "true");
      expect(chip).toHaveAttribute("data-hovered", "true");
      expect(chip).toHaveAttribute("data-pressed", "true");
    });

    it("is neither hovered nor pressed while disabled", async () => {
      const user = userEvent.setup();
      render(<Chip isDisabled>Snow</Chip>);

      await expectNoPointerStates(user, screen.getByRole("button", { name: "Snow" }));
    });
  });

  describe("controlled by its parent", () => {
    it("reports a click but does not toggle while the parent keeps isSelected as it is", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Chip isSelected={false} onChange={onChange}>
          20,000
        </Chip>,
      );
      const chip = screen.getByRole("button", { name: "20,000" });

      await user.click(chip);

      expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(chip).toHaveAttribute("aria-pressed", "false");
      expect(chip).not.toHaveAttribute("data-selected");
    });

    it("follows isSelected as the parent changes it", () => {
      const { rerender } = render(<Chip isSelected={false}>20,000</Chip>);
      const chip = screen.getByRole("button", { name: "20,000" });

      rerender(<Chip isSelected>20,000</Chip>);
      expect(chip).toHaveAttribute("aria-pressed", "true");
      expect(chip).toHaveAttribute("data-selected", "true");

      rerender(<Chip isSelected={false}>20,000</Chip>);
      expect(chip).toHaveAttribute("aria-pressed", "false");
      expect(chip).not.toHaveAttribute("data-selected");
    });
  });
});

describe("ActionChip", () => {
  it("is a one-shot button with no pressed state", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<ActionChip onPress={onPress}>Now</ActionChip>);
    const chip = screen.getByRole("button", { name: "Now" });

    expect(chip).not.toHaveAttribute("aria-pressed");

    await user.click(chip);
    await user.click(chip);

    expect(onPress).toHaveBeenCalledTimes(2);
    expect(chip).not.toHaveAttribute("aria-pressed");
  });

  it("fires on Enter and Space", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<ActionChip onPress={onPress}>+3 h</ActionChip>);
    screen.getByRole("button", { name: "+3 h" }).focus();

    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("is disabled, and ignores presses while it is", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <ActionChip isDisabled onPress={onPress}>
        Tomorrow 06:00
      </ActionChip>,
    );
    const chip = screen.getByRole("button", { name: "Tomorrow 06:00" });

    await user.click(chip);

    expect(chip).toBeDisabled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("takes a leading icon that assistive technology skips", () => {
    render(<ActionChip leadingIcon={Clock}>Tomorrow 06:00</ActionChip>);

    const icon = screen.getByRole("button", { name: "Tomorrow 06:00" }).querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("merges a caller class name", () => {
    render(<ActionChip className="custom">Tomorrow 06:00</ActionChip>);

    expect(screen.getByRole("button", { name: "Tomorrow 06:00" })).toHaveClass("custom");
  });

  it("has no accessibility violations beside toggle chips", async () => {
    const { container } = render(
      <div>
        <Chip>Wind</Chip>
        <Chip defaultSelected>Rain</Chip>
        <Chip isDisabled>Snow</Chip>
        <ActionChip>Now</ActionChip>
        <ActionChip isDisabled>+3 h</ActionChip>
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  describe("interaction states", () => {
    it("is hovered while the pointer rests on it", async () => {
      const user = userEvent.setup();
      render(<ActionChip>Now</ActionChip>);

      await expectHoverState(user, screen.getByRole("button", { name: "Now" }));
    });

    it("is pressed while a pointer button is held down on it", async () => {
      const user = userEvent.setup();
      render(<ActionChip>Now</ActionChip>);

      await expectPressedState(user, screen.getByRole("button", { name: "Now" }));
    });

    it("shows the focus ring when the keyboard puts focus on it", async () => {
      const user = userEvent.setup();
      render(<ActionChip>Now</ActionChip>);

      await expectKeyboardFocusState(user, screen.getByRole("button", { name: "Now" }));
    });
  });
});
