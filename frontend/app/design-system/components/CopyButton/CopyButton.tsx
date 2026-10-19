import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { StandInButton, type StandInButtonProps } from "../StandInButton";
import { toast } from "../Toast";

/** How long the check icon replaces the copy icon after a successful copy. */
const COPIED_ICON_MS = 2000;

/** Props for {@link CopyButton}. */
export interface CopyButtonProps extends Omit<
  StandInButtonProps,
  "variant" | "size" | "tone" | "onPress" | "children"
> {
  /** The text written to the clipboard. */
  readonly text: string;
  /** Visible label, for example "Copy link". */
  readonly children: ReactNode;
  /** Toast shown after a successful copy (microcopy `app.copyLinkDone`). */
  readonly successMessage: string;
  /** Toast shown when copying fails (microcopy `app.copyLinkFailed`). */
  readonly failureMessage: string;
  /** Height from the desktop breakpoint up: 32 px or 40 px. Defaults to `md`. */
  readonly size?: "sm" | "md";
}

async function writeToClipboard(text: string): Promise<boolean> {
  // The Clipboard API is absent outside secure contexts, so check before using it.
  if (!("clipboard" in navigator)) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Secondary button that copies `text` to the clipboard. On success the icon becomes a check for
 * 2 s and a success toast appears; on failure an error toast appears and the icon stays. Needs a
 * `ToastRegion` somewhere in the app to show the toasts.
 */
export function CopyButton({
  text,
  children,
  successMessage,
  failureMessage,
  size = "md",
  ...props
}: CopyButtonProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(revertTimer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    if (await writeToClipboard(text)) {
      setCopied(true);
      clearTimeout(revertTimer.current);
      revertTimer.current = setTimeout(() => {
        setCopied(false);
      }, COPIED_ICON_MS);
      toast.success(successMessage);
    } else {
      toast.error(failureMessage);
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <StandInButton
      {...props}
      variant="secondary"
      size={size}
      onPress={() => {
        void copy();
      }}
    >
      <Icon size={16} aria-hidden="true" />
      {children}
    </StandInButton>
  );
}
