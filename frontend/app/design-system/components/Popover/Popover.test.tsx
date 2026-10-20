import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Button } from "../Button";
import { Popover } from "./Popover";

function Anchored({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={ref}>
        Marker 7
      </button>
      <Popover label="Checkpoint 7" triggerRef={ref} isOpen onOpenChange={onOpenChange}>
        <p>Moderate risk</p>
      </Popover>
    </>
  );
}

describe("Popover", () => {
  it("is closed until the trigger is pressed", () => {
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>}>
        <p>Risk levels</p>
      </Popover>,
    );

    expect(screen.getByRole("button", { name: "Legend" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a named dialog beside the trigger and shows its content", async () => {
    const user = userEvent.setup();
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>}>
        <p>Risk levels</p>
      </Popover>,
    );

    await user.click(screen.getByRole("button", { name: "Legend" }));

    const dialog = await screen.findByRole("dialog", { name: "Legend" });
    expect(dialog).toHaveTextContent("Risk levels");
    expect(screen.getByRole("button", { name: "Legend", hidden: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>}>
        <p>Risk levels</p>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Legend" });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // React Aria hands focus back on the next animation frame.
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it("closes on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <p>Outside</p>
        <Popover label="Legend" trigger={<Button>Legend</Button>}>
          <p>Risk levels</p>
        </Popover>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Legend" }));
    await screen.findByRole("dialog");

    await user.click(document.body);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can start open", async () => {
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>} defaultOpen>
        <p>Risk levels</p>
      </Popover>,
    );

    expect(await screen.findByRole("dialog", { name: "Legend" })).toBeInTheDocument();
  });

  it("is controlled by isOpen and reports changes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>} isOpen onOpenChange={onOpenChange}>
        <p>Risk levels</p>
      </Popover>,
    );
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "Legend" })).toBeInTheDocument();
  });

  it("anchors to an element you already have, without a trigger", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Anchored onOpenChange={onOpenChange} />);

    const dialog = await screen.findByRole("dialog", { name: "Checkpoint 7" });
    expect(dialog).toHaveTextContent("Moderate risk");

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["checkpoint", "checkpoint"],
    ["content", undefined],
  ] as const)("is %s width when asked for %s", async (expected, width) => {
    // One popover at a time: an open popover hides everything else from assistive technology.
    render(
      <Popover
        label="Details"
        trigger={<Button>Open</Button>}
        defaultOpen
        {...(width === undefined ? {} : { width })}
      >
        <p>Details</p>
      </Popover>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Details" });

    expect(dialog.closest("[data-width]")).toHaveAttribute("data-width", expected);
  });

  it("places itself where asked and hides its arrow from assistive technology", async () => {
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>} placement="top" defaultOpen>
        <p>Risk levels</p>
      </Popover>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Legend" });
    const popover = dialog.closest("[data-width]");
    expect(popover).toHaveAttribute("data-placement", "top");
    expect(popover?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("hides the rest of the page from assistive technology while a modal popover is open", async () => {
    render(
      <>
        <Popover label="Modal" trigger={<Button>Modal trigger</Button>} defaultOpen>
          <p>Hides the page</p>
        </Popover>
        <p>Page text</p>
      </>,
    );
    await screen.findByRole("dialog", { name: "Modal" });
    // React Aria hides the containers the popover is not in, not the paragraph itself.
    expect(screen.getByText("Page text").closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("does not hide the page from assistive technology when non-modal", async () => {
    render(
      <>
        <Popover label="Non-modal" trigger={<Button>Open</Button>} defaultOpen isNonModal>
          <p>Leaves the page alone</p>
        </Popover>
        <p>Page text</p>
      </>,
    );
    await screen.findByRole("dialog", { name: "Non-modal" });

    expect(screen.getByText("Page text").closest("[aria-hidden='true']")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });

  it("merges a caller class name", async () => {
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>} className="custom" defaultOpen>
        <p>Risk levels</p>
      </Popover>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.closest("[data-width]")).toHaveClass("custom");
  });

  it("has no accessibility violations while open", async () => {
    render(
      <Popover label="Legend" trigger={<Button>Legend</Button>} defaultOpen>
        <p>Risk levels</p>
      </Popover>,
    );
    await screen.findByRole("dialog");

    await expectNoAxeViolations(document.body);
  });
});
