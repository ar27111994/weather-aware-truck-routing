import { cx } from "../../foundation/cx";
import styles from "./type.module.css";

/**
 * The design contract's type styles as ready-to-join class names. CSS-module lookups are
 * `string | undefined` under `noUncheckedIndexedAccess`; `cls` resolves them to plain strings.
 */
export const typography = {
  titleSm: cx(styles["titleSm"]),
  body: cx(styles["body"]),
  bodySm: cx(styles["bodySm"]),
  label: cx(styles["label"]),
  caption: cx(styles["caption"]),
  overline: cx(styles["overline"]),
  dataLg: cx(styles["dataLg"]),
  data: cx(styles["data"]),
  dataSm: cx(styles["dataSm"]),
} as const;
