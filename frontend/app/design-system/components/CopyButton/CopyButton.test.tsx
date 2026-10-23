import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { toast, ToastRegion } from "../Toast";
import { CopyButton } from "./CopyButton";
import { demo } from "./CopyButton.demo";

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

/**
 * user-event installs its own clipboard on `setup()`, so the stub (or its removal, for a browser
 * without the Clipboard API) has to come after it.
 */
function setup(
  writeText: ((text: string) => Promise<void>) | undefined,
): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  if (writeText === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    stubClipboard(writeText);
  }
  return user;
}

function renderButton(
  props: Partial<Parameters<typeof CopyButton>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <>
      <CopyButton
        text="https://haulcast.example/plan/abc"
        successMessage={t("app.copyLinkDone")}
        failureMessage={t("app.copyLinkFailed")}
        {...props}
      >
        {t("app.copyLink")}
      </CopyButton>
      <ToastRegion closeLabel="Close" />
    </>,
  );
}

function iconName(): string | null {
  return (
    screen
      .getByRole("button", { name: t("app.copyLink") })
      .querySelector("svg")
      ?.getAttribute("class") ?? null
  );
}

describe("CopyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Lets Testing Library drain its async queue under vitest fake timers (see Toast.test.tsx).
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
  });

  afterEach(() => {
    act(() => {
      toast.clear();
    });
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("renders a button named by its label with the copy icon", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderButton();

    expect(screen.getByRole("button", { name: t("app.copyLink") })).toBeEnabled();
    expect(iconName()).toContain("lucide-copy");
  });

  it("writes the text to the clipboard, swaps to the check icon and shows the success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    renderButton();

    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    expect(writeText).toHaveBeenCalledWith("https://haulcast.example/plan/abc");
    expect(iconName()).toContain("lucide-check");
    expect(screen.getByRole("region")).toHaveTextContent(t("app.copyLinkDone"));
  });

  it("reverts the icon after 2 s", async () => {
    const user = setup(vi.fn().mockResolvedValue(undefined));
    renderButton();
    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(iconName()).toContain("lucide-check");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(iconName()).toContain("lucide-copy");
  });

  it("restarts the 2 s window when copied again", async () => {
    const user = setup(vi.fn().mockResolvedValue(undefined));
    renderButton();
    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(iconName()).toContain("lucide-check");
  });

  it("shows the failure toast and keeps the icon when the write is rejected", async () => {
    const user = setup(vi.fn().mockRejectedValue(new Error("denied")));
    renderButton();

    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    expect(screen.getByRole("region")).toHaveTextContent(t("app.copyLinkFailed"));
    expect(iconName()).toContain("lucide-copy");
  });

  it("shows the failure toast when the clipboard API is missing", async () => {
    const user = setup(undefined);
    renderButton();

    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    expect(screen.getByRole("region")).toHaveTextContent(t("app.copyLinkFailed"));
    expect(iconName()).toContain("lucide-copy");
  });

  it("does nothing while disabled", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    renderButton({ isDisabled: true });

    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    expect(screen.getByRole("button", { name: t("app.copyLink") })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
  });

  // CopyButton is a design-system Button with a label, an icon and a press handler, so its own
  // states come from the Button, whose tests cover them one by one. These check that they reach it.
  describe("interaction states", () => {
    it("wires hover, press and keyboard focus onto the button", async () => {
      const user = setup(vi.fn().mockResolvedValue(undefined));
      renderButton();
      const button = screen.getByRole("button", { name: t("app.copyLink") });

      await expectKeyboardFocusState(user, button);
      await expectHoverState(user, button);
      await expectPressedState(user, button);
    });

    it("is neither hovered nor pressed while disabled, and copies nothing", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const user = setup(writeText);
      renderButton({ isDisabled: true });

      await expectNoPointerStates(user, screen.getByRole("button", { name: t("app.copyLink") }));
      await user.pointer({ keys: "[/MouseLeft]" });

      expect(writeText).not.toHaveBeenCalled();
    });
  });

  it.each(["{Enter}", " "])("activates from the keyboard with %j", async (key) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    renderButton();

    await user.tab();
    await user.keyboard(key);

    expect(writeText).toHaveBeenCalledOnce();
  });

  it("supports both sizes", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { rerender } = renderButton({ size: "sm" });
    expect(screen.getByRole("button")).toBeInTheDocument();

    rerender(
      <CopyButton text="x" size="md" successMessage="ok" failureMessage="no">
        {t("app.copyLink")}
      </CopyButton>,
    );
    expect(screen.getByRole("button", { name: t("app.copyLink") })).toBeInTheDocument();
  });

  it("clears its revert timer on unmount", async () => {
    const user = setup(vi.fn().mockResolvedValue(undefined));
    const { unmount } = renderButton();
    await user.click(screen.getByRole("button", { name: t("app.copyLink") }));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("has no axe violations, including the demo", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = renderButton();
    const rendered = render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const [first] = rendered.getAllByRole("button", { name: t("app.copyLink") });
    if (first === undefined) {
      throw new Error("The demo renders no copy button");
    }
    await user.click(first);

    vi.useRealTimers();
    await expectNoAxeViolations(container);
    await expectNoAxeViolations(rendered.container);
  });
});
