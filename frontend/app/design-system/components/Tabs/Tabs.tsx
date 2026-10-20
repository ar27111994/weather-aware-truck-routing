import type { ReactElement, ReactNode } from "react";
import {
  SelectionIndicator,
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps as AriaTabListProps,
  type TabPanelProps as AriaTabPanelProps,
  type TabProps as AriaTabProps,
  type TabsProps as AriaTabsProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { typography } from "../_shared/typography";
import styles from "./Tabs.module.css";

/** Props for {@link Tabs}. Activation is always automatic: the arrow keys move and select. */
export type TabsProps = Omit<AriaTabsProps, "className" | "style" | "keyboardActivation">;

/** Props for {@link TabList}. The tabs have no visible label, so an accessible name is required. */
export type TabListProps<T extends object> = Omit<
  AriaTabListProps<T>,
  "className" | "style" | "aria-label"
> & {
  readonly "aria-label": string;
};

/** Props for {@link Tab}. */
export type TabProps = Omit<AriaTabProps, "className" | "style" | "children"> & {
  /** The tab's text label. */
  readonly children: ReactNode;
};

/** Props for {@link TabPanel}. */
export type TabPanelProps = Omit<AriaTabPanelProps, "className" | "style">;

/**
 * Tabs root: one selected tab, one visible panel. Arrow keys move focus and select at once, Home
 * and End jump to the first and last tab, and the selection can be controlled (`selectedKey`) or
 * uncontrolled (`defaultSelectedKey`).
 */
export function Tabs(props: TabsProps): ReactElement {
  return <AriaTabs {...props} keyboardActivation="automatic" className={cx(styles.tabs)} />;
}

/** The row of tabs, with a hairline under the whole row. */
export function TabList<T extends object>(props: TabListProps<T>): ReactElement {
  return <AriaTabList {...props} className={cx(styles.list)} />;
}

/** A text tab, 44 px tall, with a 3 px ink underline that slides to the selected tab. */
export function Tab({ children, ...props }: TabProps): ReactElement {
  return (
    <AriaTab {...props} className={cx(styles.tab, typography.label)}>
      {children}
      <SelectionIndicator className={cx(styles.indicator)} />
    </AriaTab>
  );
}

/** The content of one tab, shown while that tab is selected and linked to it for screen readers. */
export function TabPanel(props: TabPanelProps): ReactElement {
  return <AriaTabPanel {...props} className={cx(styles.panel, typography.body)} />;
}
