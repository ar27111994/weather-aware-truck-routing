import type { Demo } from "./foundation/demo";

/** What a `*.demo.tsx` module exports. */
export interface DemoModule {
  readonly demo?: Demo;
}

/**
 * Turns the modules `import.meta.glob` found into the list the kitchen sink renders, sorted by
 * component name. A demo file that forgot to export `demo`, two demos with one name, or a demo with
 * no states or a repeated state id are mistakes that would silently drop or hide a specimen, so
 * they fail loudly instead.
 *
 * @param modules - Module path mapped to its exports, as `import.meta.glob(..., { eager: true })` returns.
 */
export function collectDemos(modules: Readonly<Record<string, DemoModule>>): readonly Demo[] {
  const names = new Set<string>();
  const demos = Object.entries(modules).map(([path, module]) => {
    const { demo } = module;
    if (demo === undefined) {
      throw new Error(`${path} must export a "demo".`);
    }
    if (names.has(demo.name)) {
      throw new Error(`Two demos are named "${demo.name}".`);
    }
    names.add(demo.name);
    if (demo.states.length === 0) {
      throw new Error(`The "${demo.name}" demo has no states.`);
    }
    if (new Set(demo.states.map((state) => state.id)).size !== demo.states.length) {
      throw new Error(`The "${demo.name}" demo repeats a state id.`);
    }
    return demo;
  });
  return demos.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
}
