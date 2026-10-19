import type { CSSProperties } from "react";

import { cls } from "../../cls";
import { typography } from "../_shared/typography";
import styles from "./ListParts.module.css";

/**
 * Class names and the layer value of the popover list that ComboBox and Select share, so the
 * raised surface, the option rows and their states are written once (`ListParts.module.css`).
 */
export const listParts = {
  popover: cls(styles["popover"]),
  list: cls(styles["list"]),
  section: cls(styles["section"]),
  header: cls(styles["header"], typography.label),
  item: cls(styles["item"]),
  title: cls(styles["title"], typography.body),
  detail: cls(styles["detail"], typography.bodySm),
  meta: cls(typography.caption, styles["meta"]),
} as const;

/** React Aria positions popovers at a fixed z-index; the design owns the layer instead. */
export const listPopoverStyle: CSSProperties = { zIndex: "var(--z-popover)" };
