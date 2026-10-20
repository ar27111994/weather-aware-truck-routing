import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
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
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
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
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
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
