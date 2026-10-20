import { act, render, screen } from "@testing-library/react";
import { Fragment } from "react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPointerFocusState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { toast, ToastRegion } from "./Toast";
import { demo } from "./Toast.demo";

const CLOSE = "Close notification";

function renderRegion(): ReturnType<typeof render> {
  return render(<ToastRegion closeLabel={CLOSE} />);
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

  it("renders nothing while the queue is empty", () => {
    renderRegion();

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("shows a message inside a labelled region", () => {
    renderRegion();

    act(() => {
      toast.success(t("app.copyLinkDone"));
    });

    expect(screen.getByRole("region")).toHaveAccessibleName();
    expect(screen.getByRole("region")).toHaveTextContent(t("app.copyLinkDone"));
  });

  it("announces each message through an atomic alert live region", () => {
    renderRegion();

    act(() => {
      toast.error(t("app.copyLinkFailed"));
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(t("app.copyLinkFailed"));
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).not.toHaveAttribute("aria-hidden");
  });

  it("names the toast by its message", () => {
    renderRegion();

    act(() => {
      toast.info(t("app.copyLinkDone"));
    });

    expect(screen.getByRole("alertdialog", { name: t("app.copyLinkDone") })).toBeInTheDocument();
  });

  it("dismisses a success toast after 4 s", () => {
    renderRegion();
    act(() => {
      toast.success(t("app.copyLinkDone"));
    });

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismisses an info toast after 4 s", () => {
    renderRegion();
    act(() => {
      toast.info("Heads up");
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an error toast until it is closed", () => {
    renderRegion();
    act(() => {
      toast.error(t("app.copyLinkFailed"));
    });

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(t("app.copyLinkFailed"));
  });

  it("honours a custom timeout", () => {
    renderRegion();
    act(() => {
      toast.success("Quick", { timeout: 1000 });
      toast.error("Timed error", { timeout: 2000 });
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Quick");
  });

  it("shows one toast at a time and queues the rest", () => {
    renderRegion();

    act(() => {
      toast.error("First");
      toast.error("Second");
    });

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Second");
  });

  it("shows the next queued toast once the visible one is closed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRegion();
    act(() => {
      toast.error("First");
      toast.error("Second");
    });

    await user.click(screen.getByRole("button", { name: CLOSE }));

    expect(screen.getByRole("alert")).toHaveTextContent("First");
  });

  it("starts the auto-dismiss timer of a queued toast when it becomes visible", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRegion();
    act(() => {
      toast.success("Older");
      toast.error("Newer");
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Newer");

    await user.click(screen.getByRole("button", { name: CLOSE }));
    expect(screen.getByRole("alert")).toHaveTextContent("Older");
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Older");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes through the close button, which is named by closeLabel", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRegion();
    act(() => {
      toast.error(t("app.copyLinkFailed"));
    });

    await user.click(screen.getByRole("button", { name: CLOSE }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes a toast by key", () => {
    renderRegion();
    let key = "";
    act(() => {
      key = toast.error(t("app.copyLinkFailed"));
    });

    act(() => {
      toast.close(key);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("runs the action callback and closes the toast", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onAction = vi.fn();
    renderRegion();
    act(() => {
      toast.error(t("app.copyLinkFailed"), {
        action: { label: t("error.retry"), onAction },
      });
    });

    await user.click(screen.getByRole("button", { name: t("error.retry") }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("omits the action button when there is no action", () => {
    renderRegion();
    act(() => {
      toast.error(t("app.copyLinkFailed"));
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("pauses the auto-dismiss timer while the pointer is over the region", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRegion();
    act(() => {
      toast.success(t("app.copyLinkDone"));
    });

    await user.hover(screen.getByRole("region"));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.unhover(screen.getByRole("region"));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("pauses the auto-dismiss timer while focus is inside the region", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRegion();
    act(() => {
      toast.success(t("app.copyLinkDone"), {
        action: { label: t("error.retry"), onAction: vi.fn() },
      });
    });

    await user.tab();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(document.body);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("interaction states", () => {
    function showToast(onAction?: () => void): void {
      renderRegion();
      act(() => {
        toast.error(
          t("app.copyLinkFailed"),
          onAction === undefined ? {} : { action: { label: t("error.retry"), onAction } },
        );
      });
    }

    function newUser(): UserEvent {
      return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    }

    describe("region", () => {
      it("is hovered while the pointer rests on it", async () => {
        const user = newUser();
        showToast();

        await expectHoverState(user, screen.getByRole("region"));
      });

      // The region is not a tab stop (tabindex -1); F6, React Aria's landmark key, is how the
      // keyboard reaches it.
      it("shows the focus ring when the landmark key puts focus on it", async () => {
        const user = newUser();
        showToast();
        const region = screen.getByRole("region");
        expect(region).not.toHaveAttribute("data-focus-visible");

        await user.keyboard("{F6}");

        expect(region).toHaveFocus();
        expect(region).toHaveAttribute("data-focus-visible", "true");
      });

      it("shows no focus ring when a click puts focus on it", async () => {
        const user = newUser();
        showToast();

        await expectPointerFocusState(user, screen.getByRole("region"));
      });
    });

    describe("toast", () => {
      it("shows the focus ring when the keyboard puts focus on it", async () => {
        const user = newUser();
        showToast();

        await expectKeyboardFocusState(user, screen.getByRole("alertdialog"));
      });

      it("shows no focus ring when a click puts focus on it", async () => {
        const user = newUser();
        showToast();

        await expectPointerFocusState(user, screen.getByRole("alertdialog"));
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
        await user.tab(); // the toast itself is the first tab stop

        await expectKeyboardFocusState(user, action);
        await expectHoverState(user, action);
        await expectPressUntilItLeavesTheButton(user, action);

        expect(onAction).not.toHaveBeenCalled();
      });

      it("wires hover, press and keyboard focus onto the close button", async () => {
        const user = newUser();
        showToast(vi.fn());
        const close = screen.getByRole("button", { name: CLOSE });
        await user.tab(); // the toast
        await user.tab(); // the action

        await expectKeyboardFocusState(user, close);
        await expectHoverState(user, close);
        await expectPressUntilItLeavesTheButton(user, close);

        expect(screen.getByRole("alert")).toBeInTheDocument();
      });
    });
  });

  it("has no axe violations with an action and a close button", async () => {
    const { container } = renderRegion();
    act(() => {
      toast.error(t("app.copyLinkFailed"), {
        action: { label: t("error.retry"), onAction: vi.fn() },
      });
    });

    // axe schedules its work with timers, so it needs the real ones.
    vi.useRealTimers();
    await expectNoAxeViolations(document.body);
    await expectNoAxeViolations(container);
  });

  it("renders every state of the demo and shows toasts from its buttons", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Show success toast" }));
    expect(screen.getByRole("alert")).toHaveTextContent(t("app.copyLinkDone"));
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "Show error toast" }));
    expect(screen.getByRole("alert")).toHaveTextContent(t("app.copyLinkFailed"));
    await user.click(screen.getByRole("button", { name: t("error.retry") }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show info toast" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    vi.useRealTimers();
    await expectNoAxeViolations(container);
  });
});
