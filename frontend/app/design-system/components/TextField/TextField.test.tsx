import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
} from "../../../../test/states";
import { TextField } from "./TextField";
import { demo } from "./TextField.demo";

describe("TextField", () => {
  it("names the input by its label", () => {
    render(<TextField label="Plan name" />);

    expect(screen.getByRole("textbox", { name: "Plan name" })).toBeInTheDocument();
  });

  it("shows a placeholder without letting it name the field", () => {
    render(<TextField label="Plan name" placeholder="Example: Denver run" />);

    const input = screen.getByRole("textbox", { name: "Plan name" });
    expect(input).toHaveAttribute("placeholder", "Example: Denver run");
  });

  it("describes the input with its hint", () => {
    render(<TextField label="Reference" description="Printed on the shared link." />);

    expect(screen.getByRole("textbox", { name: "Reference" })).toHaveAccessibleDescription(
      "Printed on the shared link.",
    );
  });

  it("shows no hint and no error while the field is valid", () => {
    render(<TextField label="Plan name" errorMessage="Use at least 3 characters." />);

    const input = screen.getByRole("textbox", { name: "Plan name" });
    expect(input).toBeValid();
    expect(input).not.toHaveAccessibleDescription();
    expect(screen.queryByText("Use at least 3 characters.")).not.toBeInTheDocument();
  });

  it("shows the error, marks the input invalid and reads the error out with the field", () => {
    render(
      <TextField
        label="Plan name"
        description="Printed on the shared link."
        isInvalid
        errorMessage="Use at least 3 characters."
      />,
    );

    const input = screen.getByRole("textbox", { name: "Plan name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("data-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Printed on the shared link. Use at least 3 characters.",
    );
  });

  it("computes the error from the validation result when given a function", async () => {
    const user = userEvent.setup();
    render(
      <TextField
        label="Plan name"
        validate={(value) => (value.length < 3 ? "too short" : null)}
        errorMessage={({ validationErrors }) => `Fix this: ${validationErrors.join(", ")}`}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Plan name" }), "ab");

    expect(screen.getByText("Fix this: too short")).toBeInTheDocument();
  });

  it("falls back to the validation messages when no error content is given", async () => {
    const user = userEvent.setup();
    render(
      <TextField
        label="Plan name"
        validate={(value) => (value.length < 3 ? "Use at least 3 characters." : null)}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Plan name" }), "ab");

    expect(screen.getByText("Use at least 3 characters.")).toBeInTheDocument();
  });

  it("clears the error once the value becomes valid", async () => {
    const user = userEvent.setup();
    render(
      <TextField
        label="Plan name"
        validate={(value) => (value.length < 3 ? "Use at least 3 characters." : null)}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Plan name" });

    await user.type(input, "ab");
    expect(screen.getByText("Use at least 3 characters.")).toBeInTheDocument();
    await user.type(input, "c");

    expect(screen.queryByText("Use at least 3 characters.")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("works uncontrolled from a default value", async () => {
    const user = userEvent.setup();
    render(<TextField label="Plan name" defaultValue="Den" />);
    const input = screen.getByRole("textbox", { name: "Plan name" });

    await user.type(input, "ver");

    expect(input).toHaveValue("Denver");
  });

  it("works controlled and reports every change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<string> initial="">
        {({ value, onChange: store }) => (
          <TextField
            label="Plan name"
            value={value}
            onChange={(next) => {
              onChange(next);
              store(next.toUpperCase());
            }}
          />
        )}
      </Controlled>,
    );

    await user.type(screen.getByRole("textbox", { name: "Plan name" }), "ab");

    expect(onChange).toHaveBeenNthCalledWith(1, "a");
    expect(onChange).toHaveBeenNthCalledWith(2, "Ab");
    expect(screen.getByRole("textbox", { name: "Plan name" })).toHaveValue("AB");
  });

  it("is reachable and shows keyboard focus", async () => {
    const user = userEvent.setup();
    render(<TextField label="Plan name" />);

    await user.tab();

    const input = screen.getByRole("textbox", { name: "Plan name" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("data-focus-visible", "true");
  });

  it("marks hover without changing the value", async () => {
    const user = userEvent.setup();
    render(<TextField label="Plan name" />);
    const input = screen.getByRole("textbox", { name: "Plan name" });

    await user.hover(input);

    expect(input).toHaveAttribute("data-hovered", "true");
  });

  it("cannot be edited or focused while disabled, but stays in the accessibility tree", async () => {
    const user = userEvent.setup();
    render(<TextField label="Plan name" defaultValue="Locked" isDisabled />);
    const input = screen.getByRole("textbox", { name: "Plan name" });

    await user.type(input, "more");
    await user.tab();

    expect(input).toBeDisabled();
    expect(input).toHaveValue("Locked");
    expect(input).not.toHaveFocus();
    expect(input).toHaveAttribute("data-disabled", "true");
  });

  it("cannot be edited while read only, but can be focused and read", async () => {
    const user = userEvent.setup();
    render(<TextField label="Plan ID" defaultValue="hc_7Kq2" isReadOnly />);
    const input = screen.getByRole("textbox", { name: "Plan ID" });

    await user.type(input, "more");

    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("hc_7Kq2");
  });

  it("passes native input attributes through", () => {
    render(<TextField label="Email" type="email" name="email" autoComplete="email" isRequired />);

    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toBeRequired();
  });

  describe("interaction states", () => {
    it("is hovered while the pointer rests on the input", async () => {
      const user = userEvent.setup();
      render(<TextField label="Plan name" />);

      await expectHoverState(user, screen.getByRole("textbox", { name: "Plan name" }));
    });

    it("shows the focus ring when the keyboard puts focus on the input", async () => {
      const user = userEvent.setup();
      render(<TextField label="Plan name" />);

      await expectKeyboardFocusState(user, screen.getByRole("textbox", { name: "Plan name" }));
    });

    it("takes focus on a click", async () => {
      // Only the focus is asserted: React Aria keeps data-focus-visible for the keyboard, and the
      // ring a clicked text input shows is the browser's own :focus-visible (base.css).
      const user = userEvent.setup();
      render(<TextField label="Plan name" />);
      const input = screen.getByRole("textbox", { name: "Plan name" });

      await user.click(input);

      expect(input).toHaveFocus();
    });

    it("is neither hovered nor pressed while disabled", async () => {
      const user = userEvent.setup();
      render(<TextField label="Plan name" isDisabled />);

      await expectNoPointerStates(user, screen.getByRole("textbox", { name: "Plan name" }));
    });

    it("is still hovered while read only", async () => {
      const user = userEvent.setup();
      render(<TextField label="Plan ID" defaultValue="hc_7Kq2" isReadOnly />);

      await expectHoverState(user, screen.getByRole("textbox", { name: "Plan ID" }));
    });

    it("shows the focus ring when the keyboard puts focus on it while read only", async () => {
      const user = userEvent.setup();
      render(<TextField label="Plan ID" defaultValue="hc_7Kq2" isReadOnly />);

      await expectKeyboardFocusState(user, screen.getByRole("textbox", { name: "Plan ID" }));
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations by default, with a hint, invalid, disabled and read only", async () => {
      const { container } = render(
        <>
          <TextField label="One" />
          <TextField label="Two" description="Hint" />
          <TextField label="Three" isInvalid errorMessage="Bad" />
          <TextField label="Four" isDisabled />
          <TextField label="Five" isReadOnly />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = render(<>{demo.states[0]?.node}</>);

      await expectNoAxeViolations(container);
    });
  });
});
