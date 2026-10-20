import type { CSSProperties } from "react";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import styles from "./ListParts.module.css";

/**
 * Class names and the layer value of the popover list that ComboBox and Select share, so the
 * raised surface, the option rows and their states are written once (`ListParts.module.css`).
 */
export const listParts = {
  popover: cx(styles.popover),
  list: cx(styles.list),
  section: cx(styles.section),
  header: cx(styles.header, typography.label),
  item: cx(styles.item),
  title: cx(styles.title, typography.body),
  detail: cx(styles.detail, typography.bodySm),
  meta: cx(typography.caption, styles.meta),
} as const;

/** React Aria positions popovers at a fixed z-index; the design owns the layer instead. */
export const listPopoverStyle: CSSProperties = { zIndex: "var(--z-popover)" };
