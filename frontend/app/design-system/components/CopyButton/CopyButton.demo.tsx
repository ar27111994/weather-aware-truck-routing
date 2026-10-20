import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { CopyButton } from "./CopyButton";

const URL_TO_COPY = "https://haulcast.example/plan/demo";

const MESSAGES = {
  successMessage: t("app.copyLinkDone"),
  failureMessage: t("app.copyLinkFailed"),
} as const;

/**
 * What the `/design` route renders for CopyButton. Pressing one queues a toast; the Toast demo's
 * region (mounted once on the page) is what shows it.
 */
export const demo: Demo = {
  name: "CopyButton",
  description: "Copies text to the clipboard and confirms with a toast.",
  states: [
    {
      id: "medium",
      title: "Medium",
      node: (
        <CopyButton text={URL_TO_COPY} {...MESSAGES}>
          {t("app.copyLink")}
        </CopyButton>
      ),
    },
    {
      id: "small",
      title: "Small",
      node: (
        <CopyButton text={URL_TO_COPY} size="sm" {...MESSAGES}>
          {t("app.copyLink")}
        </CopyButton>
      ),
    },
    {
      id: "disabled",
      title: "Disabled",
      node: (
        <CopyButton text={URL_TO_COPY} isDisabled {...MESSAGES}>
          {t("app.copyLink")}
        </CopyButton>
      ),
    },
  ],
};
