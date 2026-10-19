// Public entry of the design system: `import { Button, t, tokens } from "~/design-system"`.
//
// Components live in ./components/<Name>/ and are re-exported below, one line each, sorted
// alphabetically, so two cards adding components only ever conflict on adjacent lines.

// Foundation
export { cx } from "./foundation/cx";
export type { ClassValue } from "./foundation/cx";
export type { Demo, DemoState } from "./foundation/demo";
export { isStringKey, t, tList, tPlural } from "./foundation/strings";
export type { ListKey, PluralKey, StringKey, StringParams } from "./foundation/strings";
export { tokens } from "./tokens/tokens";
export type { ThemeName, TokenName } from "./tokens/tokens";

// Components
export * from "./components/Button";
export * from "./components/Icon";
export * from "./components/Spinner";
export * from "./components/VisuallyHidden";
