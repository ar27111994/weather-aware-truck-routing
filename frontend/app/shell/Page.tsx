import type { ReactElement, ReactNode } from "react";

import { cx } from "../design-system/foundation/cx";
import styles from "./Page.module.css";

/** A centred reading column for ordinary pages (placeholders now, methodology and the 404 later). */
export function Page({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return <div className={cx(styles.page, className)}>{children}</div>;
}
