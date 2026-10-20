import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { installFakeTimers } from "../../../../test/fake-timers";
import { tokens } from "../../tokens/tokens";
import { Button } from "../Button";
import { TOOLTIP_DELAY_MS, Tooltip } from "./Tooltip";

// React Aria keeps a "warmed up" flag for tooltips at module level (after one tooltip closes, the
// next opens instantly for 500 ms). Every test therefore runs on fake timers, closes what it opens
// and lets the cooldown elapse, so no test can inherit another test's warm-up.
function setup(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

/**
 * Hovers a trigger the way a real mouse does. React Aria only treats a hover as a pointer hover
 * once it has seen pointer activity on the page (`getInteractionModality() === "pointer"`), and
 * `user.hover` fires `pointerenter` before its first `pointermove`, so on a fresh page the very
 * first hover would be ignored. A person's mouse always moves over the page before it reaches a
 * button, so the helper does the same first.
 */
async function hoverLikeAMouse(
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
): Promise<void> {
  await user.pointer({ target: document.body });
  await user.hover(target);
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Tooltip", () => {
  beforeEach(() => {
    installFakeTimers();
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await elapse(1000);
    }
    vi.useRealTimers();
  });

  it("is closed until the user hovers or focuses the trigger", () => {
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens at once on keyboard focus and describes the trigger", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );

    await user.tab();

    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAccessibleDescription("Copy link");

    await user.keyboard("{Escape}");
  });

  it("opens on hover only after the 400 ms delay", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );

    await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy" }));
    await elapse(TOOLTIP_DELAY_MS - 1);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await elapse(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");

    await user.keyboard("{Escape}");
  });

  it("honours a custom hover delay", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link" delay={100}>
        <Button>Copy</Button>
      </Tooltip>,
    );

    await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy" }));
    await elapse(99);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await elapse(1);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.keyboard("{Escape}");
  });

  it("closes on Escape and leaves focus on the trigger", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
  });

  it("never opens while disabled", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link" isDisabled>
        <Button>Copy</Button>
      </Tooltip>,
    );

    await user.tab();
    await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy" }));
    await elapse(TOOLTIP_DELAY_MS * 2);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("can start open and places itself on the requested side", async () => {
    const user = setup();
    render(
      <Tooltip content="Copy link" placement="bottom" defaultOpen>
        <Button>Copy</Button>
      </Tooltip>,
    );

    expect(screen.getByRole("tooltip")).toHaveAttribute("data-placement", "bottom");

    await user.tab();
    await user.keyboard("{Escape}");
  });

  it("draws an arrow that is hidden from assistive technology", () => {
    render(
      <Tooltip content="Copy link" defaultOpen>
        <Button>Copy</Button>
      </Tooltip>,
    );

    const tooltip = screen.getByRole("tooltip");
    const arrow = tooltip.querySelector("svg");
    expect(arrow).not.toBeNull();
    expect(arrow?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(tooltip).toHaveAccessibleName("Copy link");
  });

  it("keeps its hover delay in step with the design token", () => {
    expect(TOOLTIP_DELAY_MS).toBe(
      Number.parseInt(tokens.light["motion-duration-tooltip-delay"], 10),
    );
    expect(TOOLTIP_DELAY_MS).toBe(
      Number.parseInt(tokens.dark["motion-duration-tooltip-delay"], 10),
    );
  });

  it("has no accessibility violations while open", async () => {
    vi.useRealTimers();
    render(
      <Tooltip content="Copy link" defaultOpen>
        <Button>Copy</Button>
      </Tooltip>,
    );

    await expectNoAxeViolations(document.body);
  });
});
