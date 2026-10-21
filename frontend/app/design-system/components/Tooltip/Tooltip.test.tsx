import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  elapse,
  fakeTimerUser,
  hoverLikeAMouse,
  installFakeTimers,
} from "../../../../test/fake-timers";
import { tokens } from "../../tokens/tokens";
import { Button } from "../Button";
import { TOOLTIP_DELAY_MS, Tooltip } from "./Tooltip";

// React Aria keeps a "warmed up" flag for tooltips at module level (after one tooltip closes, the
// next opens instantly for 500 ms). Every test therefore runs on fake timers, closes what it opens
// and lets the cooldown elapse, so no test can inherit another test's warm-up.
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
    const user = fakeTimerUser();
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
    const user = fakeTimerUser();
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
    const user = fakeTimerUser();
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
    const user = fakeTimerUser();
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
    const user = fakeTimerUser();
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
    const user = fakeTimerUser();
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

  it("closes when the pointer leaves the trigger (R1-23)", async () => {
    const user = fakeTimerUser();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Copy" });
    await hoverLikeAMouse(user, trigger);
    await elapse(TOOLTIP_DELAY_MS);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.unhover(trigger);
    await elapse(1000);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes when focus leaves the trigger (R1-23)", async () => {
    const user = fakeTimerUser();
    render(
      <>
        <Tooltip content="Copy link">
          <Button>Copy</Button>
        </Tooltip>
        <Button>Next</Button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.tab();
    await elapse(1000);

    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  // Tooltips close when the page scrolls, because a scroll can carry the trigger away from the
  // pointer. Keyboard focus is different: the browser scrolls a trigger that is out of view into
  // view when focus reaches it, and that scroll is the focus's own. A tooltip that the same Tab
  // opened must not be taken away by it (WCAG 1.4.13, persistent), so scrolling closes only a
  // tooltip whose trigger has no keyboard focus. `e2e/overlays.spec.ts` does it in a real browser.
  it("stays open when the page scrolls while the trigger has keyboard focus", async () => {
    const user = fakeTimerUser();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(document);
    await elapse(1000);

    expect(screen.getByRole("tooltip")).toHaveTextContent("Copy link");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAccessibleDescription("Copy link");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes when the page scrolls under a tooltip that the pointer opened", async () => {
    const user = fakeTimerUser();
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    );
    await hoverLikeAMouse(user, screen.getByRole("button", { name: "Copy" }));
    await elapse(TOOLTIP_DELAY_MS);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(document);
    await elapse(1000);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
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
