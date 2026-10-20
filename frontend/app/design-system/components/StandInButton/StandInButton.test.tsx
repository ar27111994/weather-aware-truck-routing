import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { StandInCloseButton } from "./StandInButton";

describe("StandInCloseButton", () => {
  it("is named by aria-label and fires onPress by mouse and keyboard", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<StandInCloseButton aria-label="Close" onPress={onPress} />);

    const button = screen.getByRole("button", { name: "Close" });
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("ignores presses while disabled", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<StandInCloseButton aria-label="Close" isDisabled onPress={onPress} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("has no axe violations", async () => {
    const { container } = render(<StandInCloseButton aria-label="Close" />);

    await expectNoAxeViolations(container);
  });
});
