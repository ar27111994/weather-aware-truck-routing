import type { Demo } from "./foundation/demo";

/** What a `*.demo.tsx` module exports. */
export interface DemoModule {
  readonly demo?: Demo;
}

/**
 * One component's part of `/design`. The name is known at once, from the file name, and the demo
 * only when `load()` has finished. That is what lets the page list every component, and leave one
 * out of a page, without loading any of them: each section is a chunk of its own.
 */
export interface DemoSection {
  /** The component's name: `Button` for `components/Button/Button.demo.tsx`. */
  readonly name: string;
  /** Loads the demo. The promise is made once and every call returns it, so React can suspend on it. */
  readonly load: () => Promise<Demo>;
}

/** Which sections a page shows, and what was asked for that does not exist. */
export interface SectionSelection {
  /** The sections to show, in the order of the page. */
  readonly sections: readonly DemoSection[];
  /** Names that were asked for and that no component has, each once, in the order asked. */
  readonly unknown: readonly string[];
  /** Whether the page shows only some of the components, because it was asked to. */
  readonly isFiltered: boolean;
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name, "en");
}

/** A demo file that forgot to export `demo`, has no states or repeats a state id would silently hide a specimen. */
function checked(path: string, module: DemoModule): Demo {
  const { demo } = module;
  if (demo === undefined) {
    throw new Error(`${path} must export a "demo".`);
  }
  if (demo.states.length === 0) {
    throw new Error(`The "${demo.name}" demo has no states.`);
  }
  if (new Set(demo.states.map((state) => state.id)).size !== demo.states.length) {
    throw new Error(`The "${demo.name}" demo repeats a state id.`);
  }
  return demo;
}

/** Runs `make` the first time and hands every later call the same promise. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => {
    made ??= make();
    return made;
  };
}

/**
 * Turns the modules `import.meta.glob(..., { eager: true })` found into the list of demos, sorted by
 * component name. A demo file that forgot to export `demo`, two demos with one name, or a demo with
 * no states or a repeated state id are mistakes that would silently drop or hide a specimen, so
 * they fail loudly instead.
 *
 * The tests use it, because they mount every demo. The `/design` route does not: it uses
 * {@link collectSections}, so that no demo is loaded before its section is on the page.
 *
 * @param modules - Module path mapped to its exports.
 */
export function collectDemos(modules: Readonly<Record<string, DemoModule>>): readonly Demo[] {
  const names = new Set<string>();
  const demos = Object.entries(modules).map(([path, module]) => {
    const demo = checked(path, module);
    if (names.has(demo.name)) {
      throw new Error(`Two demos are named "${demo.name}".`);
    }
    names.add(demo.name);
    return demo;
  });
  return demos.toSorted(byName);
}

/**
 * Turns the loaders `import.meta.glob` found (one per demo file, nothing loaded yet) into the
 * sections of `/design`, sorted by component name. A section is named after its file, so the page
 * knows every name before it has loaded any demo. The mistakes that {@link collectDemos} rejects are
 * rejected too: two files with one name when the sections are collected, and the rest when a
 * section is loaded, because only then is the demo in hand. A demo that is not named like its file
 * is a mistake as well, for the name in the file and the name on the page must be the same.
 *
 * @param loaders - Module path mapped to the function that imports it, as `import.meta.glob` returns.
 */
export function collectSections(
  loaders: Readonly<Record<string, () => Promise<DemoModule>>>,
): readonly DemoSection[] {
  const names = new Set<string>();
  const sections = Object.entries(loaders).map(([path, loadModule]): DemoSection => {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.demo\.tsx$/, "");
    if (names.has(name)) {
      throw new Error(`Two demos are named "${name}".`);
    }
    names.add(name);
    return {
      name,
      load: once(async () => {
        const demo = checked(path, await loadModule());
        if (demo.name !== name) {
          throw new Error(`${path} exports a demo named "${demo.name}", not "${name}".`);
        }
        return demo;
      }),
    };
  });
  return sections.toSorted(byName);
}

/**
 * Picks the sections that an address asks for with `?section=Name` (repeatable). Asking for none,
 * or only for blank names, shows every section. The page keeps its own order whatever the order of
 * the request, and a name that no component has is reported, never dropped without a word, so that a
 * misspelt link does not look like an empty page.
 *
 * @param sections - Every section there is, as {@link collectSections} returns them.
 * @param requested - The values of the `section` parameter.
 */
export function selectSections(
  sections: readonly DemoSection[],
  requested: readonly string[],
): SectionSelection {
  const wanted = new Set(requested.filter((name) => name !== ""));
  if (wanted.size === 0) {
    return { sections, unknown: [], isFiltered: false };
  }
  const known = new Set(sections.map((section) => section.name));
  return {
    sections: sections.filter((section) => wanted.has(section.name)),
    unknown: [...wanted].filter((name) => !known.has(name)),
    isFiltered: true,
  };
}
