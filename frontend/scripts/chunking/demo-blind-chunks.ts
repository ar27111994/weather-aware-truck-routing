import { createHash } from "node:crypto";

import type { Rollup } from "vite";

/*
 * Chunks for the code a page loads first, chosen as if the style guide's demos did not exist.
 *
 * Rollup puts a module in the chunk that is named by the set of entry points that load it. `/design`
 * has one lazy entry point per demo (D-35: a page of one section loads one demo), and every demo
 * reaches another part of the shared code. So the shared code of a production page is cut along 40
 * lines that production pages never cross: on e560de5 the first load of `/` was 42 files and
 * 178,975 B, where all the demos behind one lazy chunk gave 22 files and 171,510 B (P1, D-48).
 *
 * `demoBlindChunks` names the groups itself. A group is the modules that the same entry points
 * load, counting the entry points a visitor reaches without the style guide, and counting every
 * demo as one entry point more, the way a single lazy chunk would: the groups are the same
 * whatever the number of demos. It is `manualChunks` with `onlyExplicitManualChunks`, so a module
 * goes where this says and nothing else is dragged along.
 *
 * It reads what Rollup keeps after tree shaking, not what the import statements say. A barrel
 * re-exports hundreds of modules and a page uses a few, and following the statements alone put
 * 94 kB of unused React Aria in the first load of `/`. So a dependency is the module that DECLARES
 * the binding that is imported, found through the barrels, the way Rollup finds it.
 */

/** The part of Rollup's record of a module that this file reads. */
export type ChunkModule = Pick<
  Rollup.ModuleInfo,
  | "ast"
  | "dynamicImporters"
  | "exports"
  | "importedIdResolutions"
  | "importedIds"
  | "isEntry"
  | "isIncluded"
>;

/** The modules of a build, as `manualChunks` is given them. */
export interface ChunkGraph {
  /** The ids of all the modules. */
  readonly ids: () => Iterable<string>;
  /** The record of one module. */
  readonly module: (id: string) => ChunkModule | null;
}

/** What differs from one project to the next. */
export interface DemoBlindOptions {
  /** Whether a module is a demo: a lazy entry point that only the style guide loads. */
  readonly isDemo: (id: string) => boolean;
  /** Whether an entry point is loaded by every page (the client entry and the root route). */
  readonly isAlwaysLoaded: (id: string) => boolean;
  /** A name for a module id that is the same on every machine: the id relative to the project. */
  readonly nameOf: (id: string) => string;
}

/** What a module that Rollup does not know of looks like. */
const NO_MODULE: ChunkModule = {
  ast: null,
  dynamicImporters: [],
  exports: null,
  importedIdResolutions: [],
  importedIds: [],
  isEntry: false,
  isIncluded: false,
};

/** A binding: `name` as the module `from` exports it. `*` is the whole module. */
interface Binding {
  readonly from: string;
  readonly name: string;
}

/** What the statements of a module say about its imports and exports. */
interface Shape {
  /** `import { name as local } from "from"`, by `local`. */
  readonly imports: ReadonlyMap<string, Binding>;
  /** The modules that are imported for their effects alone: `import "from"`. */
  readonly effects: readonly string[];
  /** The exports that hand on a binding, by exported name. Without `from`, `name` is a local. */
  readonly handedOn: ReadonlyMap<
    string,
    { readonly from: string | undefined; readonly name: string }
  >;
  /** The modules of `export * from`. */
  readonly stars: readonly string[];
}

/** An entry point of the build, with every module that loading it loads. */
interface Root {
  readonly id: string;
  readonly isEntry: boolean;
  readonly dynamicImporters: readonly string[];
  readonly reach: ReadonlySet<string>;
  /** For a lazy root: the modules that are in memory before it is loaded. */
  loaded: ReadonlySet<string>;
}

/** The name of a specifier: an identifier, or a string as in `export { a as "b-c" }`. */
function spelling(node: {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
}): string {
  return node.type === "Identifier" ? String(node.name) : String(node.value);
}

/**
 * Reads the imports and exports of a module. Rollup lists the ids that the sources resolved to in
 * the order in which it met them, so the n-th distinct source of the statements is the n-th id.
 *
 * @returns `null` when the ids and the sources do not line up (Rollup leaves out a source that it
 *   could not resolve): the statements cannot be trusted then.
 */
function shapeOf(module: ChunkModule): Shape | null {
  const resolutions = module.importedIdResolutions[Symbol.iterator]();
  const resolved = new Map<string, string>();
  const resolve = (source: { readonly value?: unknown }): string | null => {
    const written = String(source.value);
    const known = resolved.get(written);
    if (known !== undefined) return known;
    const next = resolutions.next();
    if (next.done === true) return null;
    resolved.set(written, next.value.id);
    return next.value.id;
  };

  const imports = new Map<string, Binding>();
  const effects: string[] = [];
  const handedOn = new Map<string, { readonly from: string | undefined; readonly name: string }>();
  const stars: string[] = [];
  for (const statement of module.ast?.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      const from = resolve(statement.source);
      if (from === null) return null;
      if (statement.specifiers.length === 0) effects.push(from);
      for (const specifier of statement.specifiers) {
        const name =
          specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : specifier.type === "ImportNamespaceSpecifier"
              ? "*"
              : spelling(specifier.imported);
        imports.set(specifier.local.name, { from, name });
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      const from = statement.source == null ? undefined : resolve(statement.source);
      if (from === null) return null;
      for (const specifier of statement.specifiers) {
        handedOn.set(spelling(specifier.exported), { from, name: spelling(specifier.local) });
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const from = resolve(statement.source);
      if (from === null) return null;
      if (statement.exported == null) stars.push(from);
      else handedOn.set(spelling(statement.exported), { from, name: "*" });
    }
  }
  return resolutions.next().done === true ? { imports, effects, handedOn, stars } : null;
}

/**
 * The dependencies of every module, the way Rollup counts them after tree shaking: what an import
 * loads is the module that declares the imported binding, not the barrels it passes through.
 */
function dependencyFinder(
  moduleOf: (id: string) => ChunkModule,
): (id: string) => ReadonlySet<string> {
  const isIncluded = (id: string): boolean => moduleOf(id).isIncluded === true;
  const shapes = new Map<string, Shape | null>();
  const shape = (id: string): Shape | null => {
    let known = shapes.get(id);
    if (known === undefined) {
      known = shapeOf(moduleOf(id));
      shapes.set(id, known);
    }
    return known;
  };

  /** The module that declares what the module `id` exports as `name`. */
  const declaring = (id: string, name: string, visited: Set<string> = new Set()): string => {
    const here = shape(id);
    const key = `${id}\0${name}`;
    if (here === null || visited.has(key)) return id;
    visited.add(key);
    const follow = (from: string, as: string): string =>
      as === "*" ? from : declaring(from, as, visited);

    const exported = here.handedOn.get(name);
    if (exported?.from !== undefined) return follow(exported.from, exported.name);
    if (exported !== undefined) {
      // `export { a as b }` hands on `a`, which is either declared here or imported.
      const imported = here.imports.get(exported.name);
      return imported === undefined ? id : follow(imported.from, imported.name);
    }
    for (const star of name === "default" ? [] : here.stars) {
      const found = declaring(star, name, visited);
      if (found !== star || (moduleOf(star).exports ?? []).includes(name)) return found;
    }
    return id;
  };

  const found = new Map<string, ReadonlySet<string>>();
  return (id) => {
    const known = found.get(id);
    if (known !== undefined) return known;
    const module = moduleOf(id);
    const dependencies = new Set<string>();
    found.set(id, dependencies);

    const here = shape(id);
    const needed =
      here === null
        ? [...module.importedIds]
        : [
            ...here.effects,
            ...[...here.imports.values()].flatMap(({ from, name }) => [
              from,
              name === "*" ? from : declaring(from, name),
            ]),
          ];
    // A module that is an entry point hands its exports to whoever loads it, and a route's client
    // file is nothing but re-exports: what declares them is loaded with it.
    if (module.isEntry || module.dynamicImporters.some(isIncluded)) {
      for (const name of module.exports ?? []) if (name !== "*") needed.push(declaring(id, name));
      needed.push(...(here?.stars ?? []));
    }
    for (const dependency of needed)
      if (dependency !== id && isIncluded(dependency)) dependencies.add(dependency);
    return dependencies;
  };
}

/** Every module that loading `from` loads. */
function reachFrom(
  from: Iterable<string>,
  dependenciesOf: (id: string) => ReadonlySet<string>,
): Set<string> {
  const reach = new Set<string>(from);
  const pending = [...reach];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const dependency of dependenciesOf(id)) {
      if (!reach.has(dependency)) {
        reach.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return reach;
}

/**
 * Works out, for each lazy root, what is in memory before it loads: Rollup does not count a lazy
 * entry point for a module that the files which import it have loaded already. A lazy root is
 * loaded after every entry point that holds one of its importers, so that is what they all hold.
 */
function settleLoaded(roots: readonly Root[], everything: ReadonlySet<string>): void {
  const lazy = roots.filter((root) => !root.isEntry);
  for (const root of lazy) root.loaded = everything;
  for (let changed = true; changed;) {
    changed = false;
    for (const root of lazy) {
      let next = everything;
      for (const importer of root.dynamicImporters) {
        for (const holder of roots.filter((candidate) => candidate.reach.has(importer))) {
          const before = new Set([...holder.reach, ...holder.loaded]);
          next = new Set([...next].filter((id) => before.has(id)));
        }
      }
      if (next.size !== root.loaded.size) {
        root.loaded = next;
        changed = true;
      }
    }
  }
}

/**
 * Plans the groups: the name of the group of each module that is put in one. A module that is not
 * in the plan is left to Rollup.
 *
 * @param graph - The modules of the build.
 * @param options - What differs from one project to the next.
 */
export function planChunks(
  graph: ChunkGraph,
  options: DemoBlindOptions,
): ReadonlyMap<string, string> {
  const modules = new Map<string, ChunkModule>();
  for (const id of graph.ids()) {
    const module = graph.module(id);
    if (module !== null) modules.set(id, module);
  }
  const moduleOf = (id: string): ChunkModule => modules.get(id) ?? NO_MODULE;
  const isIncluded = (id: string): boolean => moduleOf(id).isIncluded === true;
  const dependenciesOf = dependencyFinder(moduleOf);

  const roots: Root[] = [];
  for (const [id, module] of modules) {
    if (!options.isDemo(id) && (module.isEntry || module.dynamicImporters.some(isIncluded))) {
      roots.push({
        id,
        isEntry: module.isEntry,
        dynamicImporters: module.dynamicImporters,
        reach: reachFrom([id], dependenciesOf),
        loaded: new Set(),
      });
    }
  }
  const everything = new Set([...modules.keys()].filter(isIncluded));
  settleLoaded(roots, everything);

  const reachedByDemos = reachFrom([...everything].filter(options.isDemo), dependenciesOf);
  // Only the code that a first load needs: what the entry points reach by static imports.
  const reachedByEntries = reachFrom(
    roots.filter((root) => root.isEntry).map((root) => root.id),
    dependenciesOf,
  );
  const rootIds = new Set(roots.map((root) => root.id));

  const plan = new Map<string, string>();
  for (const id of reachedByEntries) {
    if (!isIncluded(id) || rootIds.has(id)) continue;
    const loadedBy = roots.filter((root) => root.reach.has(id) && !root.loaded.has(id));
    const byDemos = reachedByDemos.has(id);
    // Every module an entry point reaches is loaded by that entry point, so `loadedBy` is never
    // empty. A module that one entry point alone loads and no demo reaches is where Rollup puts it.
    if (loadedBy.length === 1 && !byDemos) continue;
    // When no page loads all of a group, a demo that needs one module of it must not download the
    // rest: the modules a demo reaches are kept apart from the others the same entry points load.
    const separate = byDemos && !loadedBy.some((root) => options.isAlwaysLoaded(root.id));
    const key = [
      ...loadedBy.map((root) => options.nameOf(root.id)).sort(),
      ...(separate ? ["demos"] : []),
    ];
    plan.set(id, `shared-${createHash("sha1").update(key.join("|")).digest("hex").slice(0, 8)}`);
  }
  return plan;
}

/**
 * `manualChunks` for `build.rollupOptions.output`, to be used with `onlyExplicitManualChunks`.
 * The plan is made once per build, when the first module asks.
 *
 * @param options - What differs from one project to the next.
 */
export function demoBlindChunks(options: DemoBlindOptions): Rollup.GetManualChunk {
  let planned: { readonly build: unknown; readonly plan: ReadonlyMap<string, string> } | undefined;
  return (id, { getModuleIds, getModuleInfo }) => {
    if (planned?.build !== getModuleInfo) {
      planned = {
        build: getModuleInfo,
        plan: planChunks({ ids: getModuleIds, module: getModuleInfo }, options),
      };
    }
    return planned.plan.get(id);
  };
}
