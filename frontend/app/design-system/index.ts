// Public entry of the design system: `import { Button, t, tokens } from "~/design-system"`.
//
// Components live in ./components/<Name>/ and are re-exported below, one line each, sorted
// alphabetically, so two cards adding components only ever conflict on adjacent lines. A test
// fails when a component folder is missing here or the lines are out of order.

// Foundation
export { cx } from "./foundation/cx";
export type { ClassValue } from "./foundation/cx";
export type { Demo, DemoState } from "./foundation/demo";
export { RISK_LEVELS, compareRisk, riskInfo, riskSortValue, riskVar } from "./foundation/risk";
export type { ApiRiskLevel, RiskInfo, RiskKey, RiskLevel, RiskPattern } from "./foundation/risk";
export { isStringKey, t, tList, tPlural } from "./foundation/strings";
export type { ListKey, PluralKey, StringKey, StringParams } from "./foundation/strings";
export {
  DARK_QUERY,
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  isTheme,
  resolveTheme,
} from "./foundation/theme";
export type { ResolvedTheme, Theme } from "./foundation/theme";
export { ThemeProvider, useTheme } from "./foundation/ThemeProvider";
export type { ThemeContextValue, ThemeProviderProps } from "./foundation/ThemeProvider";
export { useMediaQuery } from "./foundation/useMediaQuery";
export { tokens } from "./tokens/tokens";
export type { ThemeName, TokenName } from "./tokens/tokens";

// Components
export * from "./components/Badge";
export * from "./components/Banner";
export * from "./components/BottomSheet";
export * from "./components/Button";
export * from "./components/Card";
export * from "./components/Chip";
export * from "./components/ComboBox";
export * from "./components/CopyButton";
export * from "./components/DatePicker";
export * from "./components/Dialog";
export * from "./components/Divider";
export * from "./components/EmptyState";
export * from "./components/ErrorState";
export * from "./components/Icon";
export * from "./components/IconButton";
export * from "./components/Kbd";
export * from "./components/KeyValue";
export * from "./components/Layout";
export * from "./components/Legend";
export * from "./components/Link";
export * from "./components/NumberField";
export * from "./components/Popover";
export * from "./components/ProgressSteps";
export * from "./components/Segmented";
export * from "./components/Select";
export * from "./components/Skeleton";
export * from "./components/SkipLink";
export * from "./components/Slider";
export * from "./components/Spinner";
export * from "./components/StackedBar";
export * from "./components/Stat";
export * from "./components/Switch";
export * from "./components/Table";
export * from "./components/Tabs";
export * from "./components/TextField";
export * from "./components/ThemeToggle";
export * from "./components/TimeField";
export * from "./components/Toast";
export * from "./components/Tooltip";
export * from "./components/VisuallyHidden";
