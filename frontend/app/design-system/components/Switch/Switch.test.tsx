import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import { defined } from "../../../../test/defined";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { Switch } from "./Switch";

describe("Switch", () => {
  it("is a switch named by its label, off by default", () => {
    render(<Switch>Show forecast map</Switch>);

    const control = screen.getByRole("switch", { name: "Show forecast map" });
    expect(control).not.toBeChecked();
  });

  it("toggles on click and on Space when uncontrolled", async () => {
    const user = userEvent.setup();
    render(<Switch>Show forecast map</Switch>);
    const control = screen.getByRole("switch", { name: "Show forecast map" });

    await user.click(control);
    expect(control).toBeChecked();

    await user.keyboard(" ");
    expect(control).not.toBeChecked();
  });

  it("toggles when its label text is clicked", async () => {
    const user = userEvent.setup();
    render(<Switch>Show forecast map</Switch>);

    await user.click(screen.getByText("Show forecast map"));

    expect(screen.getByRole("switch")).toBeChecked();
  });

  it("starts on with defaultSelected", () => {
    render(<Switch defaultSelected>Show forecast map</Switch>);

    expect(screen.getByRole("switch")).toBeChecked();
  });

  it("follows isSelected and reports every change when controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<boolean> initial onChange={onChange}>
        {({ value, onChange: change }) => (
          <Switch isSelected={value} onChange={change}>
            Show forecast map
          </Switch>
        )}
      </Controlled>,
    );
    const control = screen.getByRole("switch");
    expect(control).toBeChecked();

    await user.click(control);

    expect(onChange).toHaveBeenCalledWith(false);
    expect(control).not.toBeChecked();
  });

  it("ignores presses while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Switch isDisabled onChange={onChange}>
        Show forecast map
      </Switch>,
    );
    const control = screen.getByRole("switch");

    await user.click(control);

    expect(onChange).not.toHaveBeenCalled();
    expect(control).toBeDisabled();
  });

  it("hides the decorative track from assistive technology and merges a class name", () => {
    const { container } = render(<Switch className="custom">Show forecast map</Switch>);

    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(container.firstElementChild).toHaveClass("custom");
  });

  it("has no accessibility violations on, off or disabled", async () => {
    const { container } = render(
      <div>
        <Switch>Off</Switch>
        <Switch defaultSelected>On</Switch>
        <Switch isDisabled>Disabled</Switch>
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  describe("interaction states", () => {
    /** The state attributes are on the row (a label), not on the hidden input inside it. */
    function rowOf(control: HTMLElement): HTMLElement {
      return defined(control.closest("label"), "the switch's row");
    }

    it("is hovered while the pointer rests on its row", async () => {
      const user = userEvent.setup();
      render(<Switch>Show forecast map</Switch>);
      const control = screen.getByRole("switch", { name: "Show forecast map" });

      await expectHoverState(user, rowOf(control));
    });

    it("is pressed while a pointer button is held down on its row", async () => {
      const user = userEvent.setup();
      render(<Switch>Show forecast map</Switch>);
      const control = screen.getByRole("switch", { name: "Show forecast map" });

      await expectPressedState(user, rowOf(control));
    });

    it("shows the focus ring on its row when the keyboard puts focus on the switch", async () => {
      const user = userEvent.setup();
      render(<Switch>Show forecast map</Switch>);
      const control = screen.getByRole("switch", { name: "Show forecast map" });

      await expectKeyboardFocusState(user, control, rowOf(control));
    });

    it("shows no focus ring when a click puts focus on the switch", async () => {
      const user = userEvent.setup();
      render(<Switch>Show forecast map</Switch>);
      const control = screen.getByRole("switch", { name: "Show forecast map" });

      await expectPointerFocusState(user, control, rowOf(control));
    });

    it("is neither hovered nor pressed while disabled", async () => {
      const user = userEvent.setup();
      render(<Switch isDisabled>Show forecast map</Switch>);
      const control = screen.getByRole("switch", { name: "Show forecast map" });

      await expectNoPointerStates(user, rowOf(control));
    });
  });
});
