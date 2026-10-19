import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { toast, ToastRegion } from "../Toast";
import { CopyButton } from "./CopyButton";
import CopyButtonDemo from "./CopyButton.demo";

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
        successMessage={copy.app.copyLinkDone}
        failureMessage={copy.app.copyLinkFailed}
        {...props}
      >
        {copy.app.copyLink}
      </CopyButton>
      <ToastRegion closeLabel="Close" />
    </>,
  );
}

function iconName(): string | null {
  return (
    screen
      .getByRole("button", { name: copy.app.copyLink })
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

    expect(screen.getByRole("button", { name: copy.app.copyLink })).toBeEnabled();
    expect(iconName()).toContain("lucide-copy");
  });

  it("writes the text to the clipboard, swaps to the check icon and shows the success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    renderButton();

    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    expect(writeText).toHaveBeenCalledWith("https://haulcast.example/plan/abc");
    expect(iconName()).toContain("lucide-check");
    expect(screen.getByRole("alert")).toHaveTextContent(copy.app.copyLinkDone);
  });

  it("reverts the icon after 2 s", async () => {
    const user = setup(vi.fn().mockResolvedValue(undefined));
    renderButton();
    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

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
    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(iconName()).toContain("lucide-check");
  });

  it("shows the failure toast and keeps the icon when the write is rejected", async () => {
    const user = setup(vi.fn().mockRejectedValue(new Error("denied")));
    renderButton();

    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    expect(screen.getByRole("alert")).toHaveTextContent(copy.app.copyLinkFailed);
    expect(iconName()).toContain("lucide-copy");
  });

  it("shows the failure toast when the clipboard API is missing", async () => {
    const user = setup(undefined);
    renderButton();

    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    expect(screen.getByRole("alert")).toHaveTextContent(copy.app.copyLinkFailed);
    expect(iconName()).toContain("lucide-copy");
  });

  it("does nothing while disabled", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    renderButton({ isDisabled: true });

    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    expect(screen.getByRole("button", { name: copy.app.copyLink })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
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
        {copy.app.copyLink}
      </CopyButton>,
    );
    expect(screen.getByRole("button", { name: copy.app.copyLink })).toBeInTheDocument();
  });

  it("clears its revert timer on unmount", async () => {
    const user = setup(vi.fn().mockResolvedValue(undefined));
    const { unmount } = renderButton();
    await user.click(screen.getByRole("button", { name: copy.app.copyLink }));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("has no axe violations, including the demo", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = renderButton();
    const demo = render(<CopyButtonDemo />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const [first] = demo.getAllByRole("button", { name: copy.app.copyLink });
    if (first === undefined) {
      throw new Error("The demo renders no copy button");
    }
    await user.click(first);

    vi.useRealTimers();
    await expectNoAxeViolations(container);
    await expectNoAxeViolations(demo.container);
  });
});
