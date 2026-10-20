import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Clock } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { ActionChip, Chip } from "./Chip";

function Controlled({ onChange }: { readonly onChange: (value: boolean) => void }): ReactElement {
  const [selected, setSelected] = useState(false);
  return (
    <Chip
      isSelected={selected}
      onChange={(value) => {
        setSelected(value);
        onChange(value);
      }}
    >
      20,000
    </Chip>
  );
}

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
    render(<Controlled onChange={onChange} />);
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

  it("ignores presses while disabled, and takes an icon and a class name", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <ActionChip isDisabled onPress={onPress} leadingIcon={Clock} className="custom">
        Tomorrow 06:00
      </ActionChip>,
    );
    const chip = screen.getByRole("button", { name: "Tomorrow 06:00" });

    await user.click(chip);

    expect(onPress).not.toHaveBeenCalled();
    expect(chip).toHaveClass("custom");
    expect(chip.querySelector("svg")).not.toBeNull();
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
});
