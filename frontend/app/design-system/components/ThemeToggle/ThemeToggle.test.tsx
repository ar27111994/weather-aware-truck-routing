import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import type { Theme } from "../../foundation/theme";
import { ThemeToggle } from "./ThemeToggle";

function Stateful({ onChange }: { readonly onChange: (theme: Theme) => void }): ReactElement {
  const [value, setValue] = useState<Theme>("system");
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

describe("ThemeToggle", () => {
  it("is a group named Theme with Light, Dark and System buttons in that order", () => {
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

  it("is operated with the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);

    await user.tab();
    expect(screen.getByRole("radio", { name: "Light theme" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();

    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("dark");
  });

  it("names every icon button with a tooltip that says the same words", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle value="system" onChange={vi.fn()} />);

    await user.tab();

    expect(screen.getByRole("tooltip")).toHaveTextContent("Light theme");
  });

  it("draws one decorative icon per button", () => {
    render(<ThemeToggle value="system" onChange={vi.fn()} />);

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.querySelectorAll("svg")).toHaveLength(1);
      expect(radio.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
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

  describe("interaction states", () => {
    it("hovers the button the pointer rests on", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);

      await expectHoverState(user, screen.getByRole("radio", { name: "Light theme" }));
    });

    it("presses the button a pointer button is held down on", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);

      await expectPressedState(user, screen.getByRole("radio", { name: "Light theme" }));
    });

    it("shows the focus ring on the button the keyboard reaches", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);

      await expectKeyboardFocusState(user, screen.getByRole("radio", { name: "Light theme" }));
    });

    it("shows no focus ring on the button a click focuses", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="system" onChange={vi.fn()} />);

      await expectPointerFocusState(user, screen.getByRole("radio", { name: "Dark theme" }));
    });

    it("hovers the selected button without deselecting it", async () => {
      const user = userEvent.setup();
      render(<ThemeToggle value="dark" onChange={vi.fn()} />);
      const selected = screen.getByRole("radio", { name: "Dark theme" });

      await user.hover(selected);

      expect(selected).toHaveAttribute("data-selected", "true");
      expect(selected).toHaveAttribute("data-hovered", "true");
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
  });
});
