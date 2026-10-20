import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { Icon } from "../Icon";
import styles from "./Segmented.module.css";

export interface SegmentedItem {
  /** Stable value reported by `onChange`. */
  readonly id: string;
  /** Visible text. */
  readonly label: string;
  /** Icon before the label (Lucide, imported by name). */
  readonly icon?: LucideIcon;
  readonly isDisabled?: boolean;
}

export interface SegmentedProps {
  /** Accessible name of the group, repeating the visible label ("Weather check every"). */
  readonly label: string;
  readonly items: readonly SegmentedItem[];
  /** Controlled selection: the `id` of the selected item. */
  readonly value?: string;
  /** Uncontrolled initial selection. */
  readonly defaultValue?: string;
  /** Called with the `id` of the newly selected item. */
  readonly onChange?: (value: string) => void;
  readonly isDisabled?: boolean;
  readonly className?: string;
}

/**
 * Single-choice segmented control on a sunken track (DESIGN.md section 10): checkpoint interval,
 * heatmap field. Exactly one item is always selected; arrows move between items.
 */
export function Segmented({
  label,
  items,
  value,
  defaultValue,
  onChange,
  isDisabled = false,
  className,
}: SegmentedProps): ReactElement {
  // The selection is always known here (controlled or not), so pressing the selected item again,
  // which React Aria reports as a "change" to the same key, is not passed on to `onChange`.
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value ?? uncontrolled;
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={isDisabled}
      selectedKeys={current === undefined ? [] : [current]}
      onSelectionChange={(keys) => {
        for (const key of keys) {
          const next = String(key);
          if (next !== current) {
            setUncontrolled(next);
            onChange?.(next);
          }
        }
      }}
      className={cx(styles["segmented"], className)}
    >
      {items.map((item) => (
        <ToggleButton
          key={item.id}
          id={item.id}
          isDisabled={item.isDisabled ?? false}
          className={cx(styles["item"])}
        >
          {item.icon === undefined ? null : <Icon icon={item.icon} size={16} />}
          {item.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
