import type { DemoModule, DemoSection } from "../app/design-system/demo-registry";
import type { Demo } from "../app/design-system/foundation/demo";

/**
 * Every `<Name>.demo.tsx` the design system has, found the way the `/design` route finds them.
 * Shared by the registry, barrel and route tests so they all look at the same set.
 */
export const DEMO_MODULES: Readonly<Record<string, DemoModule>> = import.meta.glob<DemoModule>(
  "../app/design-system/components/*/*.demo.tsx",
  { eager: true },
);

/**
 * The same files, not yet loaded: what `import.meta.glob` hands the `/design` route, which turns
 * each loader into a section that loads on its own.
 */
export const DEMO_LOADERS: Readonly<Record<string, () => Promise<DemoModule>>> =
  import.meta.glob<DemoModule>("../app/design-system/components/*/*.demo.tsx");

/** How many demo modules exist. */
export const DEMO_COUNT = Object.keys(DEMO_MODULES).length;

/**
 * A section whose demo is already in hand, shaped like the ones the `/design` route builds. The
 * promise is made once, because a component that suspends on `load()` needs the same promise on
 * every render.
 */
export function sectionOf(demo: Demo): DemoSection {
  const loaded = Promise.resolve(demo);
  return { name: demo.name, load: () => loaded };
}
