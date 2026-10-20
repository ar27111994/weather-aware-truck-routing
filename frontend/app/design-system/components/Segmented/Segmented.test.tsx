import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wind } from "lucide-react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import { radioLabel } from "../../../../test/radio";
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

/** A group followed by a button, so a test can tell whether Tab left the group. */
function GroupThenButton({ defaultValue }: { readonly defaultValue?: string }): ReactElement {
  return (
    <>
      <Segmented
        label="Weather check every"
        items={ITEMS}
        {...(defaultValue === undefined ? {} : { defaultValue })}
      />
      <button type="button">After the group</button>
    </>
  );
}

describe("Segmented", () => {
  it("is a named radio group with one radio per item", () => {
    render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

    expect(screen.getByRole("radiogroup", { name: "Weather check every" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((radio) => radioLabel(radio).textContent)).toEqual([
      "10 mi",
      "25 mi",
      "50 mi",
    ]);
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

  it("selects when the visible text of an item is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented label="Weather check every" items={ITEMS} defaultValue="25" onChange={onChange} />,
    );

    await user.click(screen.getByText("10 mi"));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("10");
    expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
  });

  it("never lets the selection become empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented label="Weather check every" items={ITEMS} defaultValue="25" onChange={onChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "25 mi" }));
    await user.keyboard(" ");

    expect(screen.getByRole("radio", { name: "25 mi" })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works without an onChange handler", async () => {
    const user = userEvent.setup();
    render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);

    await user.click(screen.getByRole("radio", { name: "10 mi" }));

    expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
  });

  it("follows the value prop when controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<string> initial="25" onChange={onChange}>
        {({ value, onChange: change }) => (
          <Segmented label="Weather check every" items={ITEMS} value={value} onChange={change} />
        )}
      </Controlled>,
    );

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
    expect(screen.getByRole("radio", { name: "Rain" })).toBeDisabled();
    expect(
      radioLabel(screen.getByRole("radio", { name: "Wind" })).querySelector("svg"),
    ).toHaveAttribute("aria-hidden", "true");

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

  // D-26: the ARIA Authoring Practices radio pattern. The same contract is asserted in the three
  // browser engines by e2e/radio-groups.spec.ts.
  describe("keyboard (APG radio group)", () => {
    it("is one tab stop, and it is the selected item", async () => {
      const user = userEvent.setup();
      render(<GroupThenButton defaultValue="25" />);

      await user.tab();
      expect(screen.getByRole("radio", { name: "25 mi" })).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: "After the group" })).toHaveFocus();
    });

    it("puts the tab stop on the first item while nothing is selected", async () => {
      const user = userEvent.setup();
      render(<GroupThenButton />);

      await user.tab();

      expect(screen.getByRole("radio", { name: "10 mi" })).toHaveFocus();
    });

    it("moves focus and selection together with the arrow keys", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Segmented
          label="Weather check every"
          items={ITEMS}
          defaultValue="25"
          onChange={onChange}
        />,
      );
      await user.tab();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "50 mi" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "25 mi" })).not.toBeChecked();
      expect(onChange).toHaveBeenLastCalledWith("50");

      await user.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(screen.getByRole("radio", { name: "10 mi" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
      expect(onChange).toHaveBeenLastCalledWith("10");
      expect(onChange).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["ArrowDown", "ArrowUp"],
      ["ArrowRight", "ArrowLeft"],
    ] as const)("treats %s as next and %s as previous", async (next, previous) => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      await user.tab();

      await user.keyboard(`{${next}}`);
      expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();

      await user.keyboard(`{${previous}}{${previous}}`);
      expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
    });

    it("wraps from the last item to the first and from the first to the last", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="50" />);
      await user.tab();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "10 mi" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "10 mi" })).toHaveFocus();

      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "50 mi" })).toHaveFocus();
    });

    it("skips a disabled item", async () => {
      const user = userEvent.setup();
      const items: readonly SegmentedItem[] = [
        { id: "a", label: "Risk" },
        { id: "b", label: "Wind", isDisabled: true },
        { id: "c", label: "Rain" },
      ];
      render(<Segmented label="Layer" items={items} defaultValue="a" />);
      await user.tab();

      await user.keyboard("{ArrowRight}");

      expect(screen.getByRole("radio", { name: "Rain" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Wind" })).not.toBeChecked();
    });

    it("keeps the selection when Tab leaves and comes back", async () => {
      const user = userEvent.setup();
      render(<GroupThenButton defaultValue="25" />);
      await user.tab();
      await user.keyboard("{ArrowRight}");

      await user.tab();
      await user.tab({ shift: true });

      expect(screen.getByRole("radio", { name: "50 mi" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "50 mi" })).toBeChecked();
    });
  });

  // The states are drawn on the item's label, so that is where React Aria sets the attributes.
  describe("interaction states", () => {
    it("hovers the item the pointer rests on", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const radio = screen.getByRole("radio", { name: "10 mi" });

      await expectHoverState(user, radioLabel(radio));
    });

    it("presses the item a pointer button is held down on", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const radio = screen.getByRole("radio", { name: "10 mi" });

      await expectPressedState(user, radioLabel(radio));
    });

    it("shows the focus ring on the item the keyboard reaches", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const radio = screen.getByRole("radio", { name: "25 mi" });

      await expectKeyboardFocusState(user, radio, radioLabel(radio));
    });

    it("shows no focus ring on the item a click focuses", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const radio = screen.getByRole("radio", { name: "50 mi" });

      await expectPointerFocusState(user, radio, radioLabel(radio));
    });

    it("hovers the selected item without deselecting it", async () => {
      const user = userEvent.setup();
      render(<Segmented label="Weather check every" items={ITEMS} defaultValue="25" />);
      const selected = radioLabel(screen.getByRole("radio", { name: "25 mi" }));

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
      const radio = screen.getByRole("radio", { name: "Rain" });

      await expectNoPointerStates(user, radioLabel(radio));
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

    it("keeps following the parent after a keyboard move it refused", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Segmented label="Weather check every" items={ITEMS} value="25" onChange={onChange} />,
      );
      await user.tab();

      await user.keyboard("{ArrowRight}");

      expect(onChange).toHaveBeenCalledExactlyOnceWith("50");
      expect(screen.getByRole("radio", { name: "25 mi" })).toBeChecked();
    });

    // R1-44: the old `value ?? uncontrolled` silently fell back to a stale internal value when a
    // parent stopped passing `value`. React Aria owns the mode now and says so.
    it("warns when the parent stops controlling the value", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { rerender } = render(
        <Segmented label="Weather check every" items={ITEMS} value="25" />,
      );

      rerender(<Segmented label="Weather check every" items={ITEMS} />);

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "WARN: A component changed from controlled to uncontrolled.",
      );
    });
  });
});
