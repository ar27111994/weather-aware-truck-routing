import { LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { Icon } from "../Icon";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<
  AriaButtonProps,
  "className" | "style" | "children" | "isPending" | "render"
> {
  /** `primary` is the single main action of a view; `danger` is reserved and unused in v1 flows. */
  readonly variant?: ButtonVariant;
  /** Heights 32, 40 and 48 px; every size is at least 44 px below 1024 px wide. */
  readonly size?: ButtonSize;
  /**
   * Loading state: the content is replaced by a spinner (the width stays locked), presses are
   * ignored, focus is kept, the button is `aria-busy`, and screen readers hear `loadingLabel`.
   */
  readonly isLoading?: boolean;
  /** What is happening while loading, e.g. "Planning routes". Defaults to "In progress". */
  readonly loadingLabel?: string;
  /** Icon before the label (Lucide, imported by name). */
  readonly leadingIcon?: LucideIcon;
  /** Icon after the label. */
  readonly trailingIcon?: LucideIcon;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** React Aria drops `aria-busy`, so the loading button adds it through the render prop. */
function renderBusyButton(domProps: ComponentPropsWithRef<"button">): ReactElement {
  return <button {...domProps} aria-busy="true" />;
}

/** Commit action button (DESIGN.md section 10). Wraps the React Aria Components Button. */
export function Button({
  variant = "secondary",
  size = "md",
  isLoading = false,
  loadingLabel,
  leadingIcon,
  trailingIcon,
  className,
  children,
  ...rest
}: ButtonProps): ReactElement {
  const iconSize = size === "lg" ? 20 : 16;
  const loadingProps = isLoading
    ? { "aria-label": loadingLabel ?? t("progress.state.active"), render: renderBusyButton }
    : {};
  return (
    <AriaButton
      {...rest}
      {...loadingProps}
      isPending={isLoading}
      data-variant={variant}
      data-size={size}
      className={cx(styles["button"], className)}
    >
      <span className={styles["content"]} aria-hidden={isLoading ? true : undefined}>
        {leadingIcon === undefined ? null : <Icon icon={leadingIcon} size={iconSize} />}
        {children}
        {trailingIcon === undefined ? null : <Icon icon={trailingIcon} size={iconSize} />}
      </span>
      {isLoading ? (
        <span className={styles["spinner"]} aria-hidden="true">
          <Icon icon={LoaderCircle} size={iconSize} className={cx(styles["glyph"])} />
        </span>
      ) : null}
    </AriaButton>
  );
}
