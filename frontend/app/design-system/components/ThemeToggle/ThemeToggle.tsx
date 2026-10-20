import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";

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

/**
 * Light, dark or system as three icon buttons in one group (DESIGN.md section 10). The selected
 * one is an ink fill; every button is named and has a tooltip. Controlled: the app header binds it
 * to the theme provider.
 */
export function ThemeToggle({ value, onChange, className }: ThemeToggleProps): ReactElement {
  return (
    <ToggleButtonGroup
      aria-label={t("app.theme.label")}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        for (const theme of THEMES) {
          if (keys.has(theme) && theme !== value) {
            onChange(theme);
          }
        }
      }}
      className={cx(styles["toggle"], className)}
    >
      {THEMES.map((theme) => (
        <Tooltip key={theme} content={labelFor(theme)}>
          <ToggleButton id={theme} aria-label={labelFor(theme)} className={cx(styles["item"])}>
            <Icon icon={ICONS[theme]} size={20} />
          </ToggleButton>
        </Tooltip>
      ))}
    </ToggleButtonGroup>
  );
}
