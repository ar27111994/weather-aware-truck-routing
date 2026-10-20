import type { DemoModule } from "../app/design-system/demo-registry";

/**
 * Every `<Name>.demo.tsx` the design system has, found the way the `/design` route finds them.
 * Shared by the registry, barrel and route tests so they all look at the same set.
 */
export const DEMO_MODULES: Readonly<Record<string, DemoModule>> = import.meta.glob<DemoModule>(
  "../app/design-system/components/*/*.demo.tsx",
  { eager: true },
);

/** How many demo modules exist. */
export const DEMO_COUNT = Object.keys(DEMO_MODULES).length;
