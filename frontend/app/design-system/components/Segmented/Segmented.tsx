import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { RadioButton, RadioField, RadioGroup } from "react-aria-components";

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
 * Single-choice segmented control on a sunken track (DESIGN.md section 10, D-26): checkpoint
 * interval, heatmap field. It is a radio group, so the keyboard follows the ARIA Authoring
 * Practices radio pattern: one tab stop (the selected item, or the first one while nothing is
 * selected), arrow keys move focus and select, and a selection can never be cleared. A disabled
 * item is skipped. `onChange` only reports a change of selection.
 *
 * Each item is a `RadioField` (the grid cell) around a `RadioButton` (the label that is drawn): the
 * hover, press, focus and selection attributes React Aria sets are on that label.
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
  return (
    <RadioGroup
      aria-label={label}
      orientation="horizontal"
      isDisabled={isDisabled}
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onChange === undefined ? {} : { onChange })}
      className={cx(styles.segmented, className)}
    >
      {items.map((item) => (
        <RadioField
          key={item.id}
          value={item.id}
          isDisabled={item.isDisabled ?? false}
          className={styles.field}
        >
          <RadioButton className={styles.item}>
            {item.icon === undefined ? null : <Icon icon={item.icon} size={16} />}
            {item.label}
          </RadioButton>
        </RadioField>
      ))}
    </RadioGroup>
  );
}
