import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { radioLabel } from "../../../../test/radio";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import type { Theme } from "../../foundation/theme";
import { ThemeToggle } from "./ThemeToggle";

function Stateful({
  initial = "system",
  onChange,
}: {
  readonly initial?: Theme;
  readonly onChange: (theme: Theme) => void;
}): ReactElement {
  const [value, setValue] = useState<Theme>(initial);
  return (
    <ThemeToggle
      value={value}
      onChange={(theme) => {
        setValue(theme);
        onChange(theme);
      }}
    />
  );
}

/** A toggle followed by a button, so a test can tell whether Tab left the group. */
function ToggleThenButton({ initial }: { readonly initial: Theme }): ReactElement {
  return (
    <>
      <Stateful initial={initial} onChange={vi.fn()} />
      <button type="button">After the toggle</button>
    </>
  );
}

describe("ThemeToggle", () => {
  it("is a radio group named Theme with Light, Dark and System radios in that order", () => {
    render(<ThemeToggle value="system" onChange={vi.fn()} />);

    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Light theme",
      "Dark theme",
      "Match system theme",
    ]);
  });

  it.each([
    ["light", "Light theme"],
    ["dark", "Dark theme"],
    ["system", "Match system theme"],
  ] as const)("shows %s as the selected one", (value, name) => {
    render(<ThemeToggle value={value} onChange={vi.fn()} />);

    expect(screen.getByRole("radio", { name })).toBeChecked();
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
  });

  it("reports the theme that was chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(onChange).toHaveBeenLastCalledWith("dark");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(onChange).toHaveBeenLastCalledWith("light");
  });

  it("does not repeat a choice that is already selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThemeToggle value="dark" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Dark theme" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
  });

  // D-26: the ARIA Authoring Practices radio pattern. The same contract is asserted in the three
  // browser engines by e2e/radio-groups.spec.ts.
  describe("keyboard (APG radio group)", () => {
    it("is one tab stop, and it is the selected radio", async () => {
      const user = userEvent.setup();
      render(<ToggleThenButton initial="dark" />);

      await user.tab();
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: "After the toggle" })).toHaveFocus();
    });

    it("moves focus and selection together with the arrow keys", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Stateful initial="dark" onChange={onChange} />);
      await user.tab();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "Match system theme" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Dark theme" })).not.toBeChecked();
      expect(onChange).toHaveBeenLastCalledWith("system");

      await user.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(screen.getByRole("radio", { name: "Light theme" })).toHaveFocus();
      expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
      expect(onChange).toHaveBeenLastCalledWith("light");
      expect(onChange).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["ArrowDown", "ArrowUp"],
      ["ArrowRight", "ArrowLeft"],
    ] as const)("treats %s as next and %s as previous", async (next, previous) => {
      const user = userEvent.setup();
      render(<Stateful initial="dark" onChange={vi.fn()} />);
      await user.tab();

      await user.keyboard(`{${next}}`);
      expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();

      await user.keyboard(`{${previous}}{${previous}}`);
      expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
    });

    it("wraps from the last radio to the first and from the first to the last", async () => {
      const user = userEvent.setup();
      render(<Stateful initial="system" onChange={vi.fn()} />);
      await user.tab();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Light theme" })).toHaveFocus();

      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Match system theme" })).toHaveFocus();
    });
  });

  describe("tooltips", () => {
    it("names each radio with a tooltip that says the same words, one at a time", async () => {
      const user = userEvent.setup();
      render(<Stateful initial="light" onChange={vi.fn()} />);

      await user.tab();
      expect(screen.getByRole("tooltip")).toHaveTextContent("Light theme");

      await user.keyboard("{ArrowRight}");
      expect(screen.getAllByRole("tooltip")).toHaveLength(1);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Dark theme");

      await user.keyboard("{ArrowRight}");
      expect(screen.getAllByRole("tooltip")).toHaveLength(1);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Match system theme");
    });

    it("closes on Escape and leaves focus on the radio", async () => {
      const user = userEvent.setup();
      render(<Stateful initial="light" onChange={vi.fn()} />);
      await user.tab();
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Light theme" })).toHaveFocus();
    });

    it("leaves no tooltip behind when focus moves on", async () => {
      const user = userEvent.setup();
      render(<ToggleThenButton initial="light" />);
      await user.tab();
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      await user.tab();

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("draws one decorative icon per radio", () => {
    render(<ThemeToggle value="system" onChange={vi.fn()} />);

    for (const radio of screen.getAllByRole("radio")) {
      const icons = radioLabel(radio).querySelectorAll("svg");
      expect(icons).toHaveLength(1);
      expect(icons[0]).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("merges a caller class name", () => {
    render(<ThemeToggle value="system" onChange={vi.fn()} className="custom" />);

    expect(screen.getByRole("radiogroup")).toHaveClass("custom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ThemeToggle value="dark" onChange={vi.fn()} />);

    await expectNoAxeViolations(container);
  });

  // The states are drawn on each radio's label, so that is where the attributes are.
  describe("interaction states", () => {
    it("hovers the radio the pointer rests on", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);
      const radio = screen.getByRole("radio", { name: "Light theme" });

      await expectHoverState(user, radio, radioLabel(radio));
    });

    it("presses the radio a pointer button is held down on", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);
      const radio = screen.getByRole("radio", { name: "Light theme" });

      await expectPressedState(user, radio, radioLabel(radio));
    });

    it("shows the focus ring on the radio the keyboard reaches", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);
      const radio = screen.getByRole("radio", { name: "Match system theme" });

      await expectKeyboardFocusState(user, radio, radioLabel(radio));
    });

    it("shows no focus ring on the radio a click focuses", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);
      const radio = screen.getByRole("radio", { name: "Dark theme" });

      await expectPointerFocusState(user, radio, radioLabel(radio));
    });

    it("hovers the selected radio without deselecting it", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="dark" onChange={vi.fn()} />);
      const radio = screen.getByRole("radio", { name: "Dark theme" });

      await user.hover(radio);

      expect(radioLabel(radio)).toHaveAttribute("data-selected", "true");
      expect(radioLabel(radio)).toHaveAttribute("data-hovered", "true");
    });
  });

  describe("controlled by its parent", () => {
    it("reports a click but does not move while the parent keeps its theme", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ThemeToggle value="system" onChange={onChange} />);

      await user.click(screen.getByRole("radio", { name: "Dark theme" }));

      expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
      expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "Dark theme" })).not.toBeChecked();
    });

    it("follows the theme the parent passes in, as when another tab changes it", () => {
      const { rerender } = render(<ThemeToggle value="system" onChange={vi.fn()} />);

      rerender(<ThemeToggle value="light" onChange={vi.fn()} />);

      expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
    });

    it("keeps following the parent after a keyboard move it refused", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ThemeToggle value="light" onChange={onChange} />);
      await user.tab();

      await user.keyboard("{ArrowRight}");

      expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
      expect(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();
    });
  });
});
