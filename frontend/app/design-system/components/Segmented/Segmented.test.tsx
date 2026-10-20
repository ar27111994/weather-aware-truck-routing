import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wind } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { Segmented } from "./Segmented";
import type { SegmentedItem } from "./Segmented";

const ITEMS: readonly SegmentedItem[] = [
  { id: "10", label: "10 mi" },
  { id: "25", label: "25 mi" },
  { id: "50", label: "50 mi" },
];

function Controlled({ onChange }: { readonly onChange: (value: string) => void }): ReactElement {
  const [value, setValue] = useState("25");
  return (
    <Segmented
      label="Weather check every"
      items={ITEMS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("Segmented", () => {
  it("is a named radio-style group with one button per item", () => {
    render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

    const group = screen.getByRole("radiogroup", { name: "Weather check every" });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("selects the default item and nothing else", () => {
    render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

    expect(screen.getByRole("radio", { name: "25 mi" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "10 mi" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "50 mi" })).not.toBeChecked();
  });

  it("starts with nothing selected when no value is given", () => {
    render(<Segmented label="Weather check every" items={ITEMS} />);

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
  });

  it("selects by click and reports the item id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented label="Weather check every" items={ITEMS} defaultValue="25" onChange={onChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "50 mi" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("50");
    expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "25 mi" })).not.toBeChecked();
  });

  it("never lets the selection become empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented label="Weather check every" items={ITEMS} defaultValue="25" onChange={onChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "25 mi" }));

    expect(screen.getByRole("radio", { name: "25 mi" })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works without an onChange handler", async () => {
    const user = userEvent.setup();
    render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

    await user.click(screen.getByRole("radio", { name: "10 mi" }));

    expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
  });

  it("moves with the arrow keys and selects what it lands on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented label="Weather check every" items={ITEMS} defaultValue="25" onChange={onChange} />,
    );

    await user.tab();
    expect(screen.getByRole("radio", { name: "10 mi" })).toHaveFocus();

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("radio", { name: "50 mi" })).toHaveFocus();

    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("50");
    expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();
  });

  it("follows the value prop when controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "10 mi" }));

    expect(onChange).toHaveBeenCalledWith("10");
    expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
  });

  it("disables the whole group or a single item", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const items: readonly SegmentedItem[] = [
      { id: "a", label: "Wind", icon: Wind },
      { id: "b", label: "Rain", isDisabled: true },
    ];
    const { rerender } = render(
      <Segmented label="Layer" items={items} defaultValue="a" onChange={onChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "Rain" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Wind" }).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    rerender(<Segmented label="Layer" items={items} defaultValue="a" isDisabled />);
    expect(screen.getByRole("radio", { name: "Wind" })).toBeDisabled();
  });

  it("merges a caller class name", () => {
    render(<Segmented label="Layer" items={ITEMS} className="custom" />);

    expect(screen.getByRole("radiogroup")).toHaveClass("custom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <div>
        <Segmented label="Weather check every" items={ITEMS} defaultValue="25" />
        <Segmented label="Disabled" items={ITEMS} defaultValue="10" isDisabled />
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  describe("interaction states", () => {
    it("hovers the item the pointer rests on", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

      await expectHoverState(user, screen.getByRole("radio", { name: "10 mi" }));
    });

    it("presses the item a pointer button is held down on", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

      await expectPressedState(user, screen.getByRole("radio", { name: "10 mi" }));
    });

    it("shows the focus ring on the item the keyboard reaches", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

      await expectKeyboardFocusState(user, screen.getByRole("radio", { name: "10 mi" }));
    });

    it("shows no focus ring on the item a click focuses", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

      await expectPointerFocusState(user, screen.getByRole("radio", { name: "50 mi" }));
    });

    it("hovers the selected item without deselecting it", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const selected = screen.getByRole("radio", { name: "25 mi" });

      await user.hover(selected);

      expect(selected).toHaveAttribute("data-selected", "true");
      expect(selected).toHaveAttribute("data-hovered", "true");
    });

    it("does not hover or press a disabled item", async () => {
      const user = userEvent.setup();
      const items: readonly SegmentedItem[] = [
        { id: "a", label: "Wind" },
        { id: "b", label: "Rain", isDisabled: true },
      ];
      render(<Segmented label="Layer" items={items} defaultValue="a" />);

      await expectNoPointerStates(user, screen.getByRole("radio", { name: "Rain" }));
    });
  });

  describe("controlled by its parent", () => {
    it("reports a click but does not move while the parent keeps its value", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Segmented label="Weather check every" items={ITEMS} value="25" onChange={onChange} />,
      );

      await user.click(screen.getByRole("radio", { name: "50 mi" }));

      expect(onChange).toHaveBeenCalledExactlyOnceWith("50");
      expect(screen.getByRole("radio", { name: "25 mi" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "50 mi" })).not.toBeChecked();
    });

    it("follows the value the parent passes in", () => {
      const { rerender } = render(
        <Segmented label="Weather check every" items={ITEMS} value="25" />,
      );

      rerender(<Segmented label="Weather check every" items={ITEMS} value="10" />);

      expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "25 mi" })).not.toBeChecked();
    });
  });
});
