import { act, render, screen, within } from "@testing-library/react";
import { Fragment } from "react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPointerFocusState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { toast, ToastRegion, type ToastAction, type ToastOptions } from "./Toast";
import { demo } from "./Toast.demo";

const CLOSE = t("toast.close");
const DONE = t("app.copyLinkDone");
const FAILED = t("app.copyLinkFailed");
const KINDS = ["success", "error", "info"] as const;
const WITH_TIMEOUT = ["success", "info"] as const;
const A_MINUTE_MS = 60_000;

function renderRegion(): ReturnType<typeof render> {
  return render(<ToastRegion closeLabel={CLOSE} />);
}

/** A button to open the toast from, and the region: what a keyboard user starts from. */
function renderWithOpener(): HTMLElement {
  render(
    <>
      <button type="button">Opener</button>
      <ToastRegion closeLabel={CLOSE} />
    </>,
  );
  return screen.getByRole("button", { name: "Opener" });
}

/** The toast region: what the visitor sees. The announcement lives outside it. */
const visibleToast = (): HTMLElement => screen.getByRole("region");

/** The persistent polite region that a screen reader hears each toast through. */
const announcement = (): HTMLElement => screen.getByRole("status");

/** Whether focus rests on something inside a toast (the region element itself does not count). */
function focusIsInsideToast(): boolean {
  const region = visibleToast();
  return region !== document.activeElement && region.contains(document.activeElement);
}

function newUser(): UserEvent {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * Stands in for `expectPressedState` on the buttons of a toast. That helper lets go over the
 * button, which activates it, and a toast closes the moment its action or close button is
 * activated, so the button would leave the page still marked pressed. Here the press is let go off
 * the button instead: that cancels it and leaves the button on the page, so its pressed state can
 * be seen going away.
 */
async function expectPressUntilItLeavesTheButton(
  user: UserEvent,
  button: HTMLElement,
): Promise<void> {
  expect(button).not.toHaveAttribute("data-pressed", "true");

  await user.pointer({ keys: "[MouseLeft>]", target: button });
  expect(button).toHaveAttribute("data-pressed", "true");

  await user.pointer({ target: document.body });
  expect(button).not.toHaveAttribute("data-pressed", "true");

  await user.pointer({ keys: "[/MouseLeft]" });
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Testing Library only drains its async queue under fake timers when a `jest` global with
    // `advanceTimersByTime` exists; without it every awaited user-event call hangs.
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
  });

  afterEach(() => {
    act(() => {
      toast.clear();
    });
    vi.useRealTimers();
  });

  it("renders no toast while the queue is empty", () => {
    renderRegion();

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("mounts a polite live region before the first toast and leaves it empty until one shows", () => {
    renderRegion();

    expect(announcement()).toHaveAttribute("aria-live", "polite");
    expect(announcement()).toHaveAttribute("aria-atomic", "true");
    expect(announcement()).toBeEmptyDOMElement();
  });

  it("shows a message inside a labelled region", () => {
    renderRegion();

    act(() => {
      toast.success(DONE);
    });

    expect(visibleToast()).toHaveAccessibleName();
    expect(visibleToast()).toHaveTextContent(DONE);
  });

  it.each(KINDS)("announces a %s toast once, politely, through the persistent region", (kind) => {
    renderRegion();
    const region = announcement();

    act(() => {
      toast[kind](FAILED);
    });

    expect(announcement()).toBe(region);
    expect(within(region).getAllByText(FAILED)).toHaveLength(1);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it.each(KINDS)("puts no alert, alertdialog or assertive live region on a %s toast", (kind) => {
    renderRegion();

    act(() => {
      toast[kind](FAILED, { action: { label: t("error.retry"), onAction: vi.fn() } });
    });

    expect(
      document.querySelectorAll('[role="alert"], [role="alertdialog"], [aria-live="assertive"]'),
    ).toHaveLength(0);
    expect(visibleToast().querySelector("[aria-live], [role='status']")).toBeNull();
  });

  it.each(WITH_TIMEOUT)("dismisses a %s toast without an action after 5 s, not before", (kind) => {
    renderRegion();
    act(() => {
      toast[kind](DONE);
    });

    tick(4999);
    expect(visibleToast()).toHaveTextContent(DONE);

    tick(1);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps an error toast until it is closed", () => {
    renderRegion();
    act(() => {
      toast.error(FAILED);
    });

    tick(10 * A_MINUTE_MS);

    expect(visibleToast()).toHaveTextContent(FAILED);
  });

  it.each(KINDS)("never dismisses a %s toast that has an action", (kind) => {
    renderRegion();
    act(() => {
      toast[kind](DONE, { action: { label: t("error.retry"), onAction: vi.fn() } });
    });

    tick(A_MINUTE_MS);

    expect(visibleToast()).toHaveTextContent(DONE);
  });

  it("honours a custom timeout on a toast without an action", () => {
    renderRegion();
    act(() => {
      toast.success("Quick", { timeout: 1000 });
      toast.error("Timed error", { timeout: 2000 });
    });

    tick(2000);

    expect(visibleToast()).toHaveTextContent("Quick");
  });

  it("does not take a timeout together with an action", () => {
    expectTypeOf<{ readonly action: ToastAction }>().toExtend<ToastOptions>();
    expectTypeOf<{ readonly timeout: number }>().toExtend<ToastOptions>();
    expectTypeOf<{
      readonly action: ToastAction;
      readonly timeout: number;
    }>().not.toExtend<ToastOptions>();
  });

  it("shows one toast at a time and queues the rest", () => {
    renderRegion();

    act(() => {
      toast.error("First");
      toast.error("Second");
    });

    expect(within(visibleToast()).getAllByRole("listitem")).toHaveLength(1);
    expect(visibleToast()).toHaveTextContent("Second");
  });

  it("shows the next queued toast once the visible one is closed", async () => {
    const user = newUser();
    renderRegion();
    act(() => {
      toast.error("First");
      toast.error("Second");
    });

    await user.click(screen.getByRole("button", { name: CLOSE }));

    expect(visibleToast()).toHaveTextContent("First");
  });

  it("starts the auto-dismiss timer of a queued toast when it becomes visible", async () => {
    const user = newUser();
    renderRegion();
    act(() => {
      toast.success("Older");
      toast.error("Newer");
    });
    tick(10_000);
    expect(visibleToast()).toHaveTextContent("Newer");

    await user.click(screen.getByRole("button", { name: CLOSE }));
    expect(visibleToast()).toHaveTextContent("Older");
    tick(4999);
    expect(visibleToast()).toHaveTextContent("Older");
    tick(1);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("closes through the close button, which is named by closeLabel", async () => {
    const user = newUser();
    renderRegion();
    act(() => {
      toast.error(FAILED);
    });

    await user.click(screen.getByRole("button", { name: CLOSE }));

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  // React Aria named the close button "Close" from its own strings; the markup here does not use
  // them, so the name is the microcopy and nothing else.
  it("names the close button by the microcopy and not by React Aria's own word", () => {
    renderRegion();

    act(() => {
      toast.error(FAILED);
    });

    expect(screen.getByRole("button", { name: "Dismiss message" })).toBe(
      screen.getByRole("button", { name: CLOSE }),
    );
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("closes a toast by key", () => {
    renderRegion();
    let key = "";
    act(() => {
      key = toast.error(FAILED);
    });

    act(() => {
      toast.close(key);
    });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("runs the action callback and closes the toast", async () => {
    const user = newUser();
    const onAction = vi.fn();
    renderRegion();
    act(() => {
      toast.error(FAILED, {
        action: { label: t("error.retry"), onAction },
      });
    });

    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("omits the action button when there is no action", () => {
    renderRegion();
    act(() => {
      toast.error(FAILED);
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("pauses the auto-dismiss timer while the pointer is over the region", async () => {
    const user = newUser();
    renderRegion();
    act(() => {
      toast.success(DONE);
    });

    await user.hover(visibleToast());
    tick(10_000);
    expect(visibleToast()).toHaveTextContent(DONE);

    await user.unhover(visibleToast());
    tick(5000);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("pauses the auto-dismiss timer while focus is inside the region", async () => {
    const user = newUser();
    renderRegion();
    act(() => {
      toast.success(DONE);
    });

    await user.tab();
    tick(10_000);
    expect(visibleToast()).toHaveTextContent(DONE);

    await user.click(document.body);
    tick(5000);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  describe("announcing", () => {
    // Some screen readers skip a live region whose text did not change. The region writes each
    // toast's message into an element keyed by the toast, so a repeat of the same words is a new
    // node in the region: an addition, not an unchanged text.
    it("announces the same message again when a toast repeats it straight away", () => {
      renderRegion();
      const region = announcement();
      act(() => {
        toast.success(DONE);
      });
      const first = within(region).getByText(DONE);

      act(() => {
        toast.success(DONE);
      });

      const second = within(region).getByText(DONE);
      expect(second).not.toBe(first);
      expect(first).not.toBeInTheDocument();
    });

    it("announces the same message again after the first toast has closed", () => {
      renderRegion();
      act(() => {
        toast.success(DONE);
      });
      tick(5000);
      expect(announcement()).toBeEmptyDOMElement();

      act(() => {
        toast.success(DONE);
      });

      expect(within(announcement()).getAllByText(DONE)).toHaveLength(1);
    });
  });

  describe("focus", () => {
    it("returns focus to the opener when a queued toast replaces the focused one", async () => {
      const user = newUser();
      const opener = renderWithOpener();
      opener.focus();
      act(() => {
        toast.error("First");
      });
      await user.tab();
      expect(focusIsInsideToast()).toBe(true);

      act(() => {
        toast.error("Second");
      });

      expect(visibleToast()).toHaveTextContent("Second");
      expect(opener).toHaveFocus();
    });

    it("returns focus to the opener when focus came to the toast by the landmark key", async () => {
      const user = newUser();
      const opener = renderWithOpener();
      opener.focus();
      act(() => {
        toast.error("First");
      });
      await user.keyboard("{F6}");
      expect(visibleToast()).toHaveFocus();
      await user.tab();
      expect(focusIsInsideToast()).toBe(true);

      act(() => {
        toast.error("Second");
      });

      expect(visibleToast()).toHaveTextContent("Second");
      expect(opener).toHaveFocus();
    });

    it("returns focus to the opener when the focused close button closes the only toast", async () => {
      const user = newUser();
      const opener = renderWithOpener();
      opener.focus();
      act(() => {
        toast.error("Only");
      });
      act(() => {
        screen.getByRole("button", { name: CLOSE }).focus();
      });

      await user.keyboard("{Enter}");

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });

    it("leaves focus alone when a toast goes away while focus is somewhere else", () => {
      const opener = renderWithOpener();
      act(() => {
        toast.error("First");
      });
      opener.focus();

      act(() => {
        toast.error("Second");
      });

      expect(opener).toHaveFocus();
    });

    it("lets focus fall to the page when it came from nowhere and its toast is replaced", () => {
      renderWithOpener();
      act(() => {
        toast.error("First");
      });
      act(() => {
        screen.getByRole("button", { name: CLOSE }).focus();
      });

      act(() => {
        toast.error("Second");
      });

      expect(document.body).toHaveFocus();
    });
  });

  describe("interaction states", () => {
    function showToast(onAction?: () => void): void {
      renderRegion();
      act(() => {
        toast.error(
          FAILED,
          onAction === undefined ? {} : { action: { label: t("error.retry"), onAction } },
        );
      });
    }

    describe("region", () => {
      it("is hovered while the pointer rests on it", async () => {
        const user = newUser();
        showToast();

        await expectHoverState(user, visibleToast());
      });

      // The region is not a tab stop (tabindex -1); F6, React Aria's landmark key, is how the
      // keyboard reaches it.
      it("shows the focus ring when the landmark key puts focus on it", async () => {
        const user = newUser();
        showToast();
        const region = visibleToast();
        expect(region).not.toHaveAttribute("data-focus-visible");

        await user.keyboard("{F6}");

        expect(region).toHaveFocus();
        expect(region).toHaveAttribute("data-focus-visible", "true");
      });

      it("shows no focus ring when a click puts focus on it", async () => {
        const user = newUser();
        showToast();

        await expectPointerFocusState(user, visibleToast());
      });
    });

    // The action and the close button are design-system Buttons and IconButtons, whose own tests
    // cover every state. The toast restyles their hover and pressed fills for its ink surface, so
    // these check that the states reach them in this toast.
    describe("buttons", () => {
      it("wires hover, press and keyboard focus onto the action", async () => {
        const user = newUser();
        const onAction = vi.fn();
        showToast(onAction);
        const action = screen.getByRole("button", { name: t("error.retry") });

        await expectKeyboardFocusState(user, action);
        await expectHoverState(user, action);
        await expectPressUntilItLeavesTheButton(user, action);

        expect(onAction).not.toHaveBeenCalled();
      });

      it("wires hover, press and keyboard focus onto the close button", async () => {
        const user = newUser();
        showToast(vi.fn());
        const close = screen.getByRole("button", { name: CLOSE });
        await user.tab(); // the action

        await expectKeyboardFocusState(user, close);
        await expectHoverState(user, close);
        await expectPressUntilItLeavesTheButton(user, close);

        expect(visibleToast()).toBeInTheDocument();
      });
    });
  });

  it("has no axe violations with an action and a close button", async () => {
    const { container } = renderRegion();
    act(() => {
      toast.error(FAILED, {
        action: { label: t("error.retry"), onAction: vi.fn() },
      });
    });

    // axe schedules its work with timers, so it needs the real ones.
    vi.useRealTimers();
    await expectNoAxeViolations(document.body);
    await expectNoAxeViolations(container);
  });

  it("renders every state of the demo and shows toasts from its buttons", async () => {
    const user = newUser();
    const { container } = render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Show success toast" }));
    expect(visibleToast()).toHaveTextContent(DONE);
    await user.click(screen.getByRole("button", { name: CLOSE }));

    await user.click(screen.getByRole("button", { name: "Show error toast" }));
    expect(visibleToast()).toHaveTextContent(FAILED);
    await user.click(screen.getByRole("button", { name: t("error.retry") }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show info toast" }));
    expect(visibleToast()).toBeInTheDocument();

    vi.useRealTimers();
    await expectNoAxeViolations(container);
  });
});
