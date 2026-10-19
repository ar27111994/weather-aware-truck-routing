import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { StandInButton, StandInCloseButton } from "./StandInButton";

describe("StandInButton", () => {
  it("renders a named button and fires onPress by mouse and keyboard", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<StandInButton onPress={onPress}>Save</StandInButton>);

    const button = screen.getByRole("button", { name: "Save" });
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it.each(["primary", "secondary", "ghost"] as const)("renders the %s variant", (variant) => {
    render(
      <StandInButton variant={variant} size="sm" tone="onInk">
        Go
      </StandInButton>,
    );

    expect(screen.getByRole("button", { name: "Go" })).toBeEnabled();
  });

  it("ignores presses while disabled", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <StandInButton isDisabled onPress={onPress}>
        Save
      </StandInButton>,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("has no axe violations", async () => {
    const { container } = render(<StandInButton variant="primary">Save</StandInButton>);

    await expectNoAxeViolations(container);
  });
});

describe("StandInCloseButton", () => {
  it("is named by aria-label and fires onPress", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<StandInCloseButton aria-label="Close" onPress={onPress} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("supports the on-ink tone and has no axe violations", async () => {
    const { container } = render(<StandInCloseButton aria-label="Close" tone="onInk" />);

    await expectNoAxeViolations(container);
  });
});
