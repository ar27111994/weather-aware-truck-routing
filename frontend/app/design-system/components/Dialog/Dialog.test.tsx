import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { Button } from "../Button";
import { Dialog, DialogTrigger } from "./Dialog";
import { demo } from "./Dialog.demo";

const CLOSE = "Close dialog";

function Example({
  onOpenChange,
  isDismissable,
}: {
  readonly onOpenChange?: (isOpen: boolean) => void;
  readonly isDismissable?: boolean;
}): ReactElement {
  return (
    <DialogTrigger {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      <Button>Open</Button>
      <Dialog
        title="Clear recent searches?"
        closeLabel={CLOSE}
        {...(isDismissable === undefined ? {} : { isDismissable })}
        actions={
          <>
            <Button slot="close">{t("search.cancel")}</Button>
            <Button slot="close" variant="primary">
              {t("search.clearRecentConfirm")}
            </Button>
          </>
        }
      >
        <p>{t("search.clearRecentConfirmBody")}</p>
      </Dialog>
    </DialogTrigger>
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Open" }));
  return screen.findByRole("dialog");
}

describe("Dialog", () => {
  it("stays closed until the trigger is pressed, then opens", async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const dialog = await openDialog(user);

    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(t("search.clearRecentConfirmBody"));
  });

  it("is labelled by its title", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await openDialog(user);

    expect(screen.getByRole("dialog", { name: "Clear recent searches?" })).toHaveAccessibleName(
      "Clear recent searches?",
    );
    expect(screen.getByRole("heading", { name: "Clear recent searches?" })).toBeInTheDocument();
  });

  it("moves focus into the dialog", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const dialog = await openDialog(user);

    expect(dialog).toContainElement(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const dialog = await openDialog(user);

    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
    }
    for (let step = 0; step < 6; step += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
    }
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await openDialog(user);

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    });
  });

  it("closes when the scrim is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    const dialog = await openDialog(user);

    const scrim = dialog.parentElement?.parentElement;
    if (!scrim) {
      throw new Error("The dialog is not wrapped in a modal and a scrim");
    }
    await user.click(scrim);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores scrim clicks when isDismissable is false but still closes from its own buttons", async () => {
    const user = userEvent.setup();
    render(<Example isDismissable={false} />);
    const dialog = await openDialog(user);

    const scrim = dialog.parentElement?.parentElement;
    if (!scrim) {
      throw new Error("The dialog is not wrapped in a modal and a scrim");
    }
    await user.click(scrim);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: CLOSE }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes from the top-right close button, named by closeLabel", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await openDialog(user);

    await user.click(screen.getByRole("button", { name: CLOSE }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    });
  });

  it("renders the actions slot in the order given", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const dialog = await openDialog(user);

    const names = Array.from(dialog.querySelectorAll("button")).map(
      (button) => button.getAttribute("aria-label") ?? button.textContent,
    );

    expect(names).toEqual([CLOSE, t("search.cancel"), t("search.clearRecentConfirm")]);
  });

  it("renders no actions row when there are no actions", async () => {
    const user = userEvent.setup();
    render(
      <DialogTrigger>
        <Button>Open</Button>
        <Dialog title="Info" closeLabel={CLOSE}>
          <p>Body</p>
        </Dialog>
      </DialogTrigger>,
    );

    const dialog = await openDialog(user);

    expect(dialog.querySelectorAll("button")).toHaveLength(1);
  });

  it("works uncontrolled with defaultOpen and reports changes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog title="Standalone" closeLabel={CLOSE} defaultOpen onOpenChange={onOpenChange}>
        <p>Body</p>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Standalone" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: CLOSE }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("works controlled through isOpen", async () => {
    const user = userEvent.setup();
    function Controlled(): ReactElement {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          <Button
            onPress={() => {
              setIsOpen(true);
            }}
          >
            Open
          </Button>
          <Dialog title="Controlled" closeLabel={CLOSE} isOpen={isOpen} onOpenChange={setIsOpen}>
            <p>Body</p>
          </Dialog>
        </>
      );
    }
    render(<Controlled />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Controlled" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  // The trigger, the close button and the actions are design-system Buttons and IconButtons: their
  // own tests cover every state. These check that each of them is wired up where this dialog puts
  // it, under DialogTrigger and inside the modal.
  describe("interaction states", () => {
    it("wires hover, press and keyboard focus onto the trigger", async () => {
      const user = userEvent.setup();
      // React Aria draws a trigger pressed for as long as its dialog is open, so the dialog is held
      // closed here to watch the press come and go.
      render(
        <DialogTrigger isOpen={false}>
          <Button>Open</Button>
          <Dialog title="Clear recent searches?" closeLabel={CLOSE}>
            <p>Body</p>
          </Dialog>
        </DialogTrigger>,
      );
      const trigger = screen.getByRole("button", { name: "Open" });

      await expectKeyboardFocusState(user, trigger);
      await expectHoverState(user, trigger);
      await expectPressedState(user, trigger);
    });

    it("is neither hovered nor pressed while the trigger is disabled, and does not open", async () => {
      const user = userEvent.setup();
      render(
        <DialogTrigger>
          <Button isDisabled>Open</Button>
          <Dialog title="Clear recent searches?" closeLabel={CLOSE}>
            <p>Body</p>
          </Dialog>
        </DialogTrigger>,
      );

      await expectNoPointerStates(user, screen.getByRole("button", { name: "Open" }));
      await user.pointer({ keys: "[/MouseLeft]" });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("wires hover, press and keyboard focus onto the close button", async () => {
      const user = userEvent.setup();
      render(<Example />);
      await openDialog(user);
      const close = screen.getByRole("button", { name: CLOSE });

      // The dialog itself has focus when it opens, so the close button is the first tab stop.
      await expectKeyboardFocusState(user, close);
      await expectHoverState(user, close);
      await expectPressedState(user, close);
    });

    it("wires hover, press and keyboard focus onto an action", async () => {
      const user = userEvent.setup();
      render(<Example />);
      await openDialog(user);
      const cancel = screen.getByRole("button", { name: t("search.cancel") });
      await user.tab(); // the close button comes first

      await expectKeyboardFocusState(user, cancel);
      await expectHoverState(user, cancel);
      await expectPressedState(user, cancel);
    });
  });

  it("has no axe violations with the dialog open", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await openDialog(user);

    await expectNoAxeViolations(document.body);
  });

  it("renders the demo, opens it and confirms with the primary action", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        {demo.states.map((state) => (
          <Fragment key={state.id}>{state.node}</Fragment>
        ))}
      </>,
    );
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: t("search.clearRecent") }));
    const dialog = await screen.findByRole("dialog", { name: t("search.clearRecentConfirmTitle") });
    expect(dialog).toHaveTextContent(t("search.clearRecentConfirmBody"));

    await user.click(screen.getByRole("button", { name: t("search.clearRecentConfirm") }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
