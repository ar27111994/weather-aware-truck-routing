import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Plus } from "lucide-react";
import { Group, Input, TextField as AriaTextField } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  FieldButton,
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
} from "./FieldParts";

describe("FieldParts", () => {
  it("exposes class names for the field root and the shared control box", () => {
    expect(fieldRootClass).toEqual(expect.any(String));
    expect(fieldControlClass).toEqual(expect.any(String));
  });

  it("labels, describes and reports the error of a field through React Aria wiring", () => {
    render(
      <AriaTextField isInvalid validationBehavior="aria" className={fieldRootClass}>
        <FieldLabel>Origin</FieldLabel>
        <Input className={fieldControlClass} />
        <FieldDescription>City, address or place</FieldDescription>
        <FieldError>Choose a starting point from the list.</FieldError>
      </AriaTextField>,
    );

    const input = screen.getByRole("textbox", { name: "Origin" });
    expect(input).toHaveAccessibleDescription(
      "City, address or place Choose a starting point from the list.",
    );
  });

  it("renders the error icon as decoration, hidden from assistive technology", () => {
    const { container } = render(
      <AriaTextField isInvalid validationBehavior="aria">
        <FieldLabel>Origin</FieldLabel>
        <Input />
        <FieldError>Bad value.</FieldError>
      </AriaTextField>,
    );

    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("passes the validation result to an error function and falls back to its messages", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AriaTextField validate={() => "from validate"} validationBehavior="aria">
          <FieldLabel>One</FieldLabel>
          <Input />
          <FieldError>{({ validationErrors }) => `fn: ${validationErrors.join()}`}</FieldError>
        </AriaTextField>
        <AriaTextField validate={() => "plain message"} validationBehavior="aria">
          <FieldLabel>Two</FieldLabel>
          <Input />
          <FieldError />
        </AriaTextField>
      </>,
    );

    await user.type(screen.getByRole("textbox", { name: "One" }), "x");
    await user.type(screen.getByRole("textbox", { name: "Two" }), "x");

    expect(screen.getByText("fn: from validate")).toBeInTheDocument();
    expect(screen.getByText("plain message")).toBeInTheDocument();
  });

  it("renders nothing for the error while the field is valid", () => {
    render(
      <AriaTextField validationBehavior="aria">
        <FieldLabel>Origin</FieldLabel>
        <Input />
        <FieldError>Hidden until invalid.</FieldError>
      </AriaTextField>,
    );

    expect(screen.queryByText("Hidden until invalid.")).not.toBeInTheDocument();
  });

  describe("FieldButton", () => {
    it("is a button named by its aria-label and handles presses", async () => {
      const user = userEvent.setup();
      const onPress = vi.fn();
      render(
        <FieldButton aria-label="Increase" onPress={onPress}>
          <Plus aria-hidden="true" size={16} />
        </FieldButton>,
      );

      await user.click(screen.getByRole("button", { name: "Increase" }));

      expect(onPress).toHaveBeenCalledOnce();
    });

    it("marks hover, press, keyboard focus and disabled state with data attributes", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <FieldButton aria-label="Increase">
          <Plus aria-hidden="true" size={16} />
        </FieldButton>,
      );
      const button = screen.getByRole("button", { name: "Increase" });

      await user.hover(button);
      expect(button).toHaveAttribute("data-hovered", "true");
      await user.tab();
      expect(button).toHaveAttribute("data-focus-visible", "true");

      rerender(
        <FieldButton aria-label="Increase" isDisabled>
          <Plus aria-hidden="true" size={16} />
        </FieldButton>,
      );
      expect(screen.getByRole("button", { name: "Increase" })).toBeDisabled();
    });

    it("works inside a group that wears the control chrome", async () => {
      const { container } = render(
        <AriaTextField>
          <FieldLabel>Amount</FieldLabel>
          <Group className={fieldControlClass}>
            <Input />
            <FieldButton aria-label="Increase">
              <Plus aria-hidden="true" size={16} />
            </FieldButton>
          </Group>
        </AriaTextField>,
      );

      await expectNoAxeViolations(container);
    });
  });
});
