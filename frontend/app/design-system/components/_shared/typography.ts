import { cls } from "../../cls";
import styles from "./type.module.css";

/**
 * The design contract's type styles as ready-to-join class names. CSS-module lookups are
 * `string | undefined` under `noUncheckedIndexedAccess`; `cls` resolves them to plain strings.
 */
export const typography = {
  titleSm: cls(styles["titleSm"]),
  body: cls(styles["body"]),
  bodySm: cls(styles["bodySm"]),
  label: cls(styles["label"]),
  caption: cls(styles["caption"]),
  overline: cls(styles["overline"]),
  dataLg: cls(styles["dataLg"]),
  data: cls(styles["data"]),
  dataSm: cls(styles["dataSm"]),
} as const;
