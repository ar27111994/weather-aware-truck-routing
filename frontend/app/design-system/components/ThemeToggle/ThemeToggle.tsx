import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef } from "react";
import type { ReactElement } from "react";
import { mergeProps, useFocusRing, useHover, useRadio, useRadioGroup } from "react-aria";
import { useRadioGroupState } from "react-stately";
import type { RadioGroupState } from "react-stately";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { THEMES } from "../../foundation/theme";
import type { Theme } from "../../foundation/theme";
import { Icon } from "../Icon";
import { Tooltip } from "../Tooltip";
import styles from "./ThemeToggle.module.css";

export interface ThemeToggleProps {
  /** The current choice. The toggle holds no state of its own. */
  readonly value: Theme;
  /** Called with the newly chosen theme (never with the one already chosen). */
  readonly onChange: (theme: Theme) => void;
  readonly className?: string;
}

const ICONS: Readonly<Record<Theme, LucideIcon>> = { light: Sun, dark: Moon, system: Monitor };

/** Words for each theme: the accessible name and the tooltip (microcopy `app.theme.*`). */
function labelFor(theme: Theme): string {
  return t(`app.theme.${theme}`);
}

interface ThemeRadioProps {
  readonly theme: Theme;
  readonly state: RadioGroupState;
}

/**
 * One icon radio. The native `<input type="radio">` covers the whole square (invisible), so the
 * pointer, the keyboard focus, the tooltip's hover and the tooltip's anchor all belong to the one
 * element that has the `radio` role. React Aria's own `Radio` hides its input in one pixel and
 * answers hover on the label instead, which a tooltip trigger cannot follow: a tooltip needs the
 * hovered element and the focused element to be the same one.
 *
 * The states are drawn on the label, as React Aria does for every radio and for the Switch.
 */
function ThemeRadio({ theme, state }: ThemeRadioProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const { inputProps, isSelected, isPressed } = useRadio(
    { value: theme, "aria-label": labelFor(theme) },
    state,
    inputRef,
  );
  const { focusProps, isFocusVisible } = useFocusRing();
  const { hoverProps, isHovered } = useHover({});
  return (
    <label
      className={styles.item}
      data-selected={isSelected || undefined}
      data-pressed={isPressed || undefined}
      data-hovered={isHovered || undefined}
      data-focus-visible={isFocusVisible || undefined}
    >
      <input
        {...mergeProps(inputProps, focusProps, hoverProps)}
        ref={inputRef}
        className={styles.input}
      />
      <Icon icon={ICONS[theme]} size={20} />
    </label>
  );
}

/**
 * Light, dark or system as three icon radios in one group (DESIGN.md section 10, D-26). The
 * selected one is an ink fill; every radio is named and has a tooltip. Controlled: the app header
 * binds it to the theme provider.
 *
 * It is a radio group, so the keyboard follows the ARIA Authoring Practices radio pattern: one tab
 * stop (the selected radio), arrow keys move focus and select, and the selection is never empty.
 */
export function ThemeToggle({ value, onChange, className }: ThemeToggleProps): ReactElement {
  const state = useRadioGroupState({
    value,
    onChange: (chosen) => {
      for (const theme of THEMES) {
        if (theme === chosen) {
          onChange(theme);
        }
      }
    },
  });
  const { radioGroupProps } = useRadioGroup(
    { "aria-label": t("app.theme.label"), orientation: "horizontal" },
    state,
  );
  return (
    <div {...radioGroupProps} className={cx(styles.toggle, className)}>
      {THEMES.map((theme) => (
        <Tooltip key={theme} content={labelFor(theme)}>
          <ThemeRadio theme={theme} state={state} />
        </Tooltip>
      ))}
    </div>
  );
}
