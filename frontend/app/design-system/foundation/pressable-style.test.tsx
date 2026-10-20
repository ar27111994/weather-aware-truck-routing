import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "../components/Button";
import { PRESSABLE_ATTRIBUTE, PRESSABLE_STYLE } from "./pressable-style";

describe("the pressable style", () => {
  it("selects the attribute React Aria puts on a pressable element", () => {
    render(<Button>Plan routes</Button>);

    expect(screen.getByRole("button")).toHaveAttribute(PRESSABLE_ATTRIBUTE);
    expect(PRESSABLE_STYLE).toContain(`[${PRESSABLE_ATTRIBUTE}]`);
  });
});
