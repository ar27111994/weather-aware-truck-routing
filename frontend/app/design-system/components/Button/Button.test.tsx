import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Check, Truck } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Button } from "./Button";

describe("Button", () => {
  it("renders a native button named by its label", () => {
    render(<Button>Plan routes</Button>);

    const button = screen.getByRole("button", { name: "Plan routes" });
    expect(button.tagName).toBe("BUTTON");
  });

  it("is a secondary, medium button unless told otherwise", () => {
    render(<Button>Edit trip</Button>);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("data-variant", "secondary");
    expect(button).toHaveAttribute("data-size", "md");
  });

  it.each(["primary", "secondary", "ghost", "danger"] as const)(
    "renders the %s variant",
    (variant) => {
      render(<Button variant={variant}>Label</Button>);

      expect(screen.getByRole("button")).toHaveAttribute("data-variant", variant);
    },
  );

  it.each(["sm", "md", "lg"] as const)("renders the %s size", (size) => {
    render(<Button size={size}>Label</Button>);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", size);
  });

  it("fires onPress on click, Enter and Space", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Plan routes</Button>);
    const button = screen.getByRole("button");

    await user.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);

    button.focus();
    await user.keyboard("{Enter}");
    expect(onPress).toHaveBeenCalledTimes(2);

    await user.keyboard(" ");
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it("submits its form when it is a submit button", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Button type="submit" variant="primary">
          Plan routes
        </Button>
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Plan routes" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while disabled but keeps its place in the accessibility tree", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <Button isDisabled onPress={onPress}>
        Plan routes
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Plan routes" });

    await user.click(button);

    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-disabled");
  });

  describe("loading", () => {
    it("announces the loading label, is busy, and keeps focus", () => {
      render(
        <Button isLoading loadingLabel="Planning routes">
          Plan routes
        </Button>,
      );

      const button = screen.getByRole("button", { name: "Planning routes" });
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(button).toHaveAttribute("data-pending");
      button.focus();
      expect(button).toHaveFocus();
    });

    it("falls back to a generic label when none is given", () => {
      render(<Button isLoading>Plan routes</Button>);

      expect(screen.getByRole("button", { name: "In progress" })).toBeInTheDocument();
    });

    it("keeps the original content in the DOM, hidden from assistive technology, to lock the width", () => {
      render(
        <Button isLoading loadingLabel="Planning routes">
          Plan routes
        </Button>,
      );

      const content = screen.getByText("Plan routes");
      expect(content.closest("[aria-hidden='true']")).not.toBeNull();
    });

    it("ignores presses", async () => {
      const user = userEvent.setup();
      const onPress = vi.fn();
      render(
        <Button isLoading loadingLabel="Planning routes" onPress={onPress}>
          Plan routes
        </Button>,
      );

      await user.click(screen.getByRole("button"));

      expect(onPress).not.toHaveBeenCalled();
    });

    it("is not busy when not loading", () => {
      render(<Button>Plan routes</Button>);

      expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
    });
  });

  describe("icons", () => {
    it("renders leading and trailing icons hidden from assistive technology", () => {
      const { container } = render(
        <Button leadingIcon={Truck} trailingIcon={Check}>
          Label
        </Button>,
      );

      const icons = container.querySelectorAll("svg");
      expect(icons).toHaveLength(2);
      for (const icon of icons) {
        expect(icon).toHaveAttribute("aria-hidden", "true");
      }
      expect(screen.getByRole("button", { name: "Label" })).toBeInTheDocument();
    });

    it("draws 16 px icons, or 20 px in the large size", () => {
      const { container, rerender } = render(<Button leadingIcon={Truck}>Label</Button>);
      expect(container.querySelector("svg")).toHaveAttribute("width", "16");

      rerender(
        <Button size="lg" leadingIcon={Truck}>
          Label
        </Button>,
      );
      expect(container.querySelector("svg")).toHaveAttribute("width", "20");
    });
  });

  it("merges a caller class name", () => {
    render(<Button className="custom">Label</Button>);

    expect(screen.getByRole("button")).toHaveClass("custom");
  });

  it("passes accessible names through for icon-only use", () => {
    render(<Button aria-label="Swap origin and destination" leadingIcon={Truck} />);

    expect(screen.getByRole("button", { name: "Swap origin and destination" })).toBeInTheDocument();
  });

  it("has no accessibility violations in any variant or state", async () => {
    const { container } = render(
      <div>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button isDisabled>Disabled</Button>
        <Button isLoading loadingLabel="Planning routes">
          Loading
        </Button>
        <Button leadingIcon={Truck} trailingIcon={Check}>
          With icons
        </Button>
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
