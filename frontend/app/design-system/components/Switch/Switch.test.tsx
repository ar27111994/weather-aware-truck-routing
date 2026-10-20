import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Switch } from "./Switch";

function Controlled({ onChange }: { readonly onChange: (value: boolean) => void }): ReactElement {
  const [selected, setSelected] = useState(true);
  return (
    <Switch
      isSelected={selected}
      onChange={(value) => {
        setSelected(value);
        onChange(value);
      }}
    >
      Show forecast map
    </Switch>
  );
}

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
    render(<Controlled onChange={onChange} />);
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
});
