import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { Button } from "../Button";
import { Dialog, DialogTrigger } from "./Dialog";

/** What the `/design` route renders for Dialog: the one confirmation the product uses. */
export const demo: Demo = {
  name: "Dialog",
  description: "Modal confirmation dialog with focus trap, scrim and a close button.",
  states: [
    {
      id: "confirmation",
      title: "Confirmation: opens on press, Escape or the scrim closes it",
      node: (
        <DialogTrigger>
          <Button>{t("search.clearRecent")}</Button>
          <Dialog
            title={t("search.clearRecentConfirmTitle")}
            closeLabel={t("dialog.close")}
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
      ),
    },
  ],
};
