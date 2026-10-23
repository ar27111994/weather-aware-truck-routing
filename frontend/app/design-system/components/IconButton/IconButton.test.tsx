import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Copy, X } from "lucide-react";
import { Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  elapse,
  fakeTimerUser,
  hoverLikeAMouse,
  installFakeTimers,
} from "../../../../test/fake-timers";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { TOOLTIP_DELAY_MS } from "../Tooltip/Tooltip";
import { IconButton } from "./IconButton";
import { demo } from "./IconButton.demo";

describe("IconButton", () => {
  it("renders a native button named by its label, with a decorative 20 px icon", () => {
    render(<IconButton icon={Copy} label="Copy link" />);

    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.tagName).toBe("BUTTON");
    const icon = button.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
  });

  it("is a ghost, medium button unless told otherwise", () => {
    render(<IconButton icon={Copy} label="Copy link" />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("data-variant", "ghost");
    expect(button).toHaveAttribute("data-size", "md");
  });

  it.each(["ghost", "secondary"] as const)("renders the %s variant", (variant) => {
    render(<IconButton icon={Copy} label="Copy link" variant={variant} />);

    expect(screen.getByRole("button")).toHaveAttribute("data-variant", variant);
  });

  it.each(["sm", "md", "lg"] as const)("renders the %s size", (size) => {
    render(<IconButton icon={Copy} label="Copy link" size={size} />);

    expect(screen.getByRole("button")).toHaveAttribute("data-size", size);
  });

  it("fires onPress on click, Enter and Space", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<IconButton icon={X} label="Close" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Close" });

    await user.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);

    button.focus();
    await user.keyboard("{Enter}");
    expect(onPress).toHaveBeenCalledTimes(2);

    await user.keyboard(" ");
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it("passes the button type through, so it can submit a form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <IconButton icon={Copy} label="Submit" type="submit" />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while disabled but keeps its place in the accessibility tree", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<IconButton icon={X} label="Close" isDisabled onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Close" });

    await user.click(button);

    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-disabled");
  });

  describe("tooltip", () => {
    it("shows the label as a tooltip on keyboard focus", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" />);

      await user.tab();

      expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");
      expect(screen.getByRole("button", { name: "Copy link" })).toHaveAccessibleDescription(
        "Copy link",
      );
    });

    it("stays quiet when showTooltip is off", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" showTooltip={false} />);

      await user.tab();

      expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    // The two tests below run on a fake clock: with real timers "no tooltip yet" is also true of
    // an enabled button 399 ms after the pointer arrives (R1-19).
    describe("on a hover", () => {
      beforeEach(() => {
        installFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("opens after the hover delay when enabled, so the quiet test below can fail", async () => {
        const user = fakeTimerUser();
        render(<IconButton icon={Copy} label="Copy link" />);

        await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy link" }));
        await elapse(TOOLTIP_DELAY_MS);

        expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");
        await user.keyboard("{Escape}");
      });

      it("stays quiet while disabled, however long the pointer rests on it", async () => {
        const user = fakeTimerUser();
        render(<IconButton icon={Copy} label="Copy link" isDisabled />);

        await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy link" }));
        await elapse(TOOLTIP_DELAY_MS * 3);

        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    });
  });

  it("merges a caller class name", () => {
    render(<IconButton icon={Copy} label="Copy link" className="custom" />);

    expect(screen.getByRole("button")).toHaveClass("custom");
  });

  it("has no accessibility violations in any variant, size or state", async () => {
    const { container } = render(
      <div>
        <IconButton icon={Copy} label="Ghost small" size="sm" />
        <IconButton icon={Copy} label="Ghost medium" />
        <IconButton icon={Copy} label="Ghost large" size="lg" />
        <IconButton icon={Copy} label="Secondary small" variant="secondary" size="sm" />
        <IconButton icon={Copy} label="Secondary medium" variant="secondary" />
        <IconButton icon={Copy} label="Secondary large" variant="secondary" size="lg" />
        <IconButton icon={Copy} label="No tooltip" showTooltip={false} />
        <IconButton icon={Copy} label="Disabled" isDisabled />
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  describe("interaction states", () => {
    it("is hovered while the pointer rests on it", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" />);

      await expectHoverState(user, screen.getByRole("button", { name: "Copy link" }));
    });

    it("is pressed while a pointer button is held down on it", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" />);

      await expectPressedState(user, screen.getByRole("button", { name: "Copy link" }));
    });

    it("shows the focus ring when the keyboard puts focus on it", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" />);

      await expectKeyboardFocusState(user, screen.getByRole("button", { name: "Copy link" }));
    });

    it("shows no focus ring when a click puts focus on it", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" />);

      await expectPointerFocusState(user, screen.getByRole("button", { name: "Copy link" }));
    });

    it("is neither hovered nor pressed while disabled", async () => {
      const user = userEvent.setup();
      render(<IconButton icon={Copy} label="Copy link" isDisabled />);

      await expectNoPointerStates(user, screen.getByRole("button", { name: "Copy link" }));
    });
  });

  it("names the close specimen of the demo from the microcopy key dialog.close (R3-29)", () => {
    render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );

    expect(screen.getByRole("button", { name: t("dialog.close") })).toBeInTheDocument();
  });
});
