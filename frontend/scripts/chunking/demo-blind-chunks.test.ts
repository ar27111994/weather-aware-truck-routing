// @vitest-environment node
// `vite` loads esbuild, which refuses to start under jsdom (its `Uint8Array` is not Node's).
import { parseAst } from "vite";
import type { Rollup } from "vite";
import { describe, expect, it, vi } from "vitest";

import { demoBlindChunks, planChunks } from "./demo-blind-chunks.ts";
import type { ChunkGraph, ChunkModule, DemoBlindOptions } from "./demo-blind-chunks.ts";

/** One module of a pretend build. A module is named by its key, and `./name` imports it. */
interface Fake {
  /** The statements of the module. */
  readonly code?: string;
  /** An entry point of the build. */
  readonly entry?: boolean;
  /** Tree shaking kept nothing of the module (a barrel that only re-exports, say). */
  readonly dropped?: boolean;
  /** The modules whose `import()` loads it. */
  readonly lazyFrom?: readonly string[];
  /** The names Rollup lists as its exports. */
  readonly exports?: readonly string[];
  /** Sources that Rollup could not resolve, and so leaves out of its list of ids. */
  readonly unresolved?: readonly string[];
  /** Ids in Rollup's list that no statement asks for. */
  readonly extraIds?: readonly string[];
  /** Rollup has no syntax tree of the module to give. */
  readonly noAst?: boolean;
}

type Fakes = Readonly<Record<string, Fake>>;

const OPTIONS: DemoBlindOptions = {
  isDemo: (id) => id.endsWith(".demo"),
  isAlwaysLoaded: (id) => id === "root" || id === "client",
  nameOf: (id) => `app/${id}`,
};

/** What Rollup lists for an import that resolved to the module `id` of the build. */
function resolved(id: string): Rollup.ResolvedId {
  return {
    id,
    external: false,
    resolvedBy: "test",
    attributes: {},
    meta: {},
    moduleSideEffects: true,
    syntheticNamedExports: false,
  };
}

/** What Rollup would tell about `fake`: the ids come in the order of the sources. */
function moduleOf(fake: Fake, prefix: string): ChunkModule {
  const ast = parseAst(fake.code ?? "");
  const sources = new Set<string>();
  for (const statement of ast.body) {
    if ("source" in statement && statement.source != null)
      sources.add(String(statement.source.value));
  }
  const ids = [
    ...(fake.noAst === true ? [] : [...sources]).filter(
      (source) => !(fake.unresolved ?? []).includes(source),
    ),
    ...(fake.extraIds ?? []).map((id) => `./${id}`),
  ].map((source) => `${prefix}${source.slice(2)}`);
  return {
    ast: fake.noAst === true ? null : ast,
    dynamicImporters: (fake.lazyFrom ?? []).map((id) => `${prefix}${id}`),
    exports: fake.exports === undefined ? null : [...fake.exports],
    importedIdResolutions: ids.map(resolved),
    importedIds: ids,
    isEntry: fake.entry === true,
    isIncluded: fake.dropped !== true,
  };
}

/** The records of a pretend build, as `planChunks` reads them. `prefix` is the folder the ids sit in. */
function graphOf(fakes: Fakes, prefix = ""): ChunkGraph {
  return {
    // `ghost` is an id that the build lists and has no record of.
    ids: () => [...Object.keys(fakes), "ghost"].map((id) => `${prefix}${id}`),
    module: (id) => {
      const fake = fakes[id.slice(prefix.length)];
      return fake === undefined ? null : moduleOf(fake, prefix);
    },
  };
}

/** The plan for a pretend build, made with the options of these tests. */
function planOf(fakes: Fakes): ReadonlyMap<string, string> {
  return planChunks(graphOf(fakes), OPTIONS);
}

/** A page that imports modules for their effects, which is the simplest way to load them. */
const page = (...names: string[]): Fake => ({
  entry: true,
  code: names.map((name) => `import "./${name}";`).join(" "),
});

/** A module that does nothing but declare one name. */
const plain = (name: string): Fake => ({ code: `export const ${name} = 1;` });
const LAZY_DEMO = { entry: true, code: `export const load = () => import("./x.demo");` };

/** Two pages that share three modules, and a style guide whose demos reach some of them. */
const TWO_PAGES: Fakes = {
  a: page("s1", "s2", "s3"),
  b: page("s1", "s2", "s3"),
  design: LAZY_DEMO,
  "x.demo": { lazyFrom: ["design"], code: `import "./s1";` },
  "y.demo": { lazyFrom: ["design"], code: `import "./s2";` },
  s1: plain("s1"),
  s2: plain("s2"),
  s3: plain("s3"),
};

const GROUP = /^shared-[0-9a-f]{8}$/u;

describe("planChunks: what the demos do not change", () => {
  it("puts the code that the same pages load in one group, whichever demo reaches which part", () => {
    const plan = planOf(TWO_PAGES);

    expect(plan.get("s1")).toMatch(GROUP);
    expect(plan.get("s2")).toBe(plan.get("s1"));
  });

  it("keeps what no demo reaches apart from what a demo reaches, when a page may skip the group", () => {
    const plan = planOf(TWO_PAGES);

    expect(plan.get("s3")).toMatch(GROUP);
    expect(plan.get("s3")).not.toBe(plan.get("s1"));
  });

  it("makes the same groups however many demos there are", () => {
    const withMoreDemos: Fakes = {
      ...TWO_PAGES,
      "z.demo": { lazyFrom: ["design"], code: `import "./s1";` },
      "w.demo": { lazyFrom: ["design"], code: `import "./s2";` },
    };

    expect(planOf(withMoreDemos)).toEqual(planOf(TWO_PAGES));
  });

  it("does not let a demo drag in what no page of the first load uses", () => {
    const plan = planOf({
      ...TWO_PAGES,
      "x.demo": { lazyFrom: ["design"], code: `import "./s1"; import "./onlyDemos";` },
      onlyDemos: plain("onlyDemos"),
    });

    expect(plan.has("onlyDemos")).toBe(false);
  });

  it("gives a group the same name on every machine, because the name comes from `nameOf`", () => {
    const prefix = "/home/ci/work/";
    const here = planOf(TWO_PAGES);
    const there = planChunks(graphOf(TWO_PAGES, prefix), {
      isDemo: OPTIONS.isDemo,
      isAlwaysLoaded: (id) => OPTIONS.isAlwaysLoaded(id.replace(prefix, "")),
      nameOf: (id) => OPTIONS.nameOf(id.replace(prefix, "")),
    });

    expect(there.get(`${prefix}s1`)).toBe(here.get("s1"));
    expect(there.get(`${prefix}s3`)).toBe(here.get("s3"));
  });
});

describe("planChunks: the pages that every page loads", () => {
  const shared: Fakes = {
    m1: plain("m1"),
    m2: plain("m2"),
    design: LAZY_DEMO,
    "x.demo": { lazyFrom: ["design"], code: `import "./m1";` },
  };

  it("does not keep a demo's modules apart when every page loads the group anyway", () => {
    const plan = planOf({ ...shared, client: page("m1", "m2"), a: page("m1", "m2") });

    expect(plan.get("m1")).toBe(plan.get("m2"));
  });

  it("keeps them apart when a page may skip the group", () => {
    const plan = planOf({ ...shared, a: page("m1", "m2"), b: page("m1", "m2") });

    expect(plan.get("m1")).not.toBe(plan.get("m2"));
  });
});

describe("planChunks: the code that every page loads is one download", () => {
  // `client` and `root` are loaded by every page, so whatever they load is downloaded by every visit.
  // Which other page or lazy chunk also loads a part of it only decides how Rollup would have cut
  // it, and every cut is one more request in front of the first paint.
  const everyPage: Fakes = {
    client: page("m1", "m2", "m3", "m4"),
    root: page("m1", "m2", "m3", "m4"),
    a: page("m1"),
    b: page("m2"),
    design: LAZY_DEMO,
    "x.demo": { lazyFrom: ["design"], code: `import "./m1"; import "./m3";` },
    m1: plain("m1"),
    m2: plain("m2"),
    m3: plain("m3"),
    m4: plain("m4"),
  };

  it("puts all of it in one group, whichever pages and demos load a part of it", () => {
    const plan = planOf(everyPage);

    expect(new Set(["m1", "m2", "m3", "m4"].map((name) => plan.get(name)))).toEqual(
      new Set([plan.get("m1")]),
    );
    expect(plan.get("m1")).toBeDefined();
  });

  it("names the group for what it holds, the same on every machine", () => {
    expect(planOf(everyPage).get("m1")).toBe("core");
  });

  it("puts the framework in a group of its own, so that a release that leaves it alone keeps its URL", () => {
    const withFramework: Fakes = {
      ...everyPage,
      client: page("m1", "m2", "m3", "m4", "react"),
      root: page("m1", "m2", "m3", "m4", "react"),
      react: plain("react"),
    };
    const plan = planChunks(graphOf(withFramework), {
      ...OPTIONS,
      isVendor: (id) => id === "react",
    });

    expect(plan.get("react")).toBe("vendor");
    expect(plan.get("m1")).toBe("core");
  });

  it("keeps the framework with the rest when no module is named a framework module", () => {
    const plan = planOf({
      ...everyPage,
      client: page("m1", "m2", "m3", "m4", "react"),
      root: page("m1", "m2", "m3", "m4", "react"),
      react: plain("react"),
    });

    expect(plan.get("react")).toBe("core");
  });

  it("does not name a group for a module that only one entry point loads and no demo reaches", () => {
    const plan = planOf({
      ...everyPage,
      client: page("m1", "m2", "m3", "m4", "own"),
      own: plain("own"),
    });

    expect(plan.has("own")).toBe(false);
  });

  it("keeps apart what no always-loaded entry point loads: a page may skip it", () => {
    const plan = planOf({
      client: page("m1"),
      root: page("m1"),
      a: page("only", "ab"),
      b: page("only", "ab"),
      c: page("ab"),
      m1: plain("m1"),
      only: plain("only"),
      ab: plain("ab"),
    });

    expect(plan.get("only")).toMatch(GROUP);
    expect(plan.get("ab")).toMatch(GROUP);
    expect(plan.get("only")).not.toBe(plan.get("ab"));
    expect(plan.get("only")).not.toBe(plan.get("m1"));
  });
});

describe("planChunks: what is left to Rollup", () => {
  it("leaves a module that one entry point alone loads, unless a demo reaches it too", () => {
    const plan = planOf({
      a: page("solo", "soloDemo"),
      design: LAZY_DEMO,
      "x.demo": { lazyFrom: ["design"], code: `import "./soloDemo";` },
      solo: plain("solo"),
      soloDemo: plain("soloDemo"),
    });

    expect(plan.has("solo")).toBe(false);
    expect(plan.has("soloDemo")).toBe(true);
  });

  it("leaves what only a lazy chunk loads: it is no part of a first load", () => {
    const plan = planOf({
      a: { entry: true, code: `export const load = () => import("./lazy");` },
      b: { entry: true, code: `export const load = () => import("./lazy");` },
      lazy: { lazyFrom: ["a", "b"], code: `import "./later";` },
      later: plain("later"),
    });

    expect(plan.has("later")).toBe(false);
  });

  it("leaves the entry points, the demos, and what tree shaking dropped", () => {
    const plan = planOf({
      ...TWO_PAGES,
      a: page("s1", "s2", "s3", "dropped"),
      dropped: { dropped: true, code: `import "./behind";` },
      behind: plain("behind"),
    });

    expect(plan.has("a")).toBe(false);
    expect(plan.has("x.demo")).toBe(false);
    expect(plan.has("dropped")).toBe(false);
    expect(plan.has("behind")).toBe(false);
  });

  it("leaves a module that the build has no record of", () => {
    const plan = planOf({ a: page("gone", "s1"), b: page("s1"), s1: plain("s1") });

    expect(plan.has("gone")).toBe(false);
    expect(plan.has("s1")).toBe(true);
  });
});

describe("planChunks: what a lazy chunk finds already loaded", () => {
  it("does not count a lazy entry point for what every page that loads it has loaded", () => {
    const plan = planOf({
      a: {
        entry: true,
        code: `import "./ab"; import "./m1"; import "./m2"; export const l = () => import("./lazy");`,
      },
      b: {
        entry: true,
        code: `import "./ab"; import "./m1"; export const l = () => import("./lazy");`,
      },
      lazy: { lazyFrom: ["a", "b"], exports: ["thing"], code: `import "./m1"; import "./m2";` },
      ab: plain("ab"),
      m1: plain("m1"),
      m2: plain("m2"),
    });

    // `a` and `b` have loaded m1 before they load `lazy`: it is one more module of the two pages.
    // Only `a` has loaded m2, so a visit that goes through `b` still has to fetch it with `lazy`.
    expect(plan.get("m1")).toBe(plan.get("ab"));
    expect(plan.get("m2")).not.toBe(plan.get("ab"));
  });

  it("follows a chain of lazy chunks, whatever the order they are listed in", () => {
    const plan = planOf({
      a: { entry: true, code: `import "./deep"; export const l = () => import("./lazy1");` },
      lazy2: { lazyFrom: ["lazy1"], code: `import "./deep";` },
      lazy1: {
        lazyFrom: ["a"],
        code: `import "./deep"; export const l = () => import("./lazy2");`,
      },
      deep: plain("deep"),
    });

    // `a` loads deep, `lazy1` finds it loaded, and so does `lazy2`, which only `lazy1` loads.
    expect(plan.has("deep")).toBe(false);
  });
});

describe("planChunks: what an import loads", () => {
  /** The pages that all import the same names from a barrel. */
  const viaBarrel = (names: string, barrel: Fake): Fakes => ({
    a: { entry: true, code: `import ${names} from "./barrel";` },
    b: { entry: true, code: `import ${names} from "./barrel";` },
    barrel,
    design: LAZY_DEMO,
    "x.demo": { lazyFrom: ["design"], code: `import "./calendar";` },
    button: plain("button"),
    calendar: plain("calendar"),
    starred: { exports: ["starred"], code: "export const starred = 1;" },
  });

  it("loads the module that declares a binding, not the barrel's other modules", () => {
    const plan = planOf(
      viaBarrel("{ Button }", {
        dropped: true,
        code: `import { Button as $b } from "./button";
export { $b as Button };
export { Calendar } from "./calendar";`,
      }),
    );

    expect(plan.has("button")).toBe(true);
    expect(plan.has("calendar")).toBe(false);
  });

  it("finds a binding that a barrel re-exports from a named source, by default, or under a string", () => {
    const plan = planOf({
      ...viaBarrel('{ Fancy, "b-c" as bc }', {
        dropped: true,
        code: `export { default as Fancy } from "./button";
export { x as "b-c" } from "./starred";`,
      }),
    });

    expect(plan.has("button")).toBe(true);
    expect(plan.has("starred")).toBe(true);
  });

  it("finds a binding that a barrel re-exports through `export *`", () => {
    const plan = planOf(
      viaBarrel("{ starred }", { dropped: true, code: `export * from "./starred";` }),
    );

    expect(plan.has("starred")).toBe(true);
  });

  it("goes past an `export *` that has no such binding", () => {
    const plan = planOf(
      viaBarrel("{ starred }", {
        dropped: true,
        code: `export * from "./button"; export * from "./starred";`,
      }),
    );

    expect(plan.has("starred")).toBe(true);
  });

  it("does not look for a default export behind `export *`", () => {
    const plan = planOf(viaBarrel("Main", { dropped: true, code: `export * from "./button";` }));

    // The barrel itself declares nothing here, so it is what the import loads. It was dropped.
    expect(plan.has("button")).toBe(false);
  });

  it("loads the module behind a namespace that a barrel exports, or that a page imports", () => {
    const viaNamespace = planOf(
      viaBarrel("{ everything }", {
        dropped: true,
        code: `export * as everything from "./button";`,
      }),
    );
    const viaImport = planOf({
      a: { entry: true, code: `import * as ns from "./button";` },
      b: { entry: true, code: `import * as ns from "./button";` },
      button: plain("button"),
    });

    expect(viaNamespace.has("button")).toBe(true);
    expect(viaImport.has("button")).toBe(true);
  });

  it("loads a module that is imported for its effects", () => {
    const plan = planOf({ a: page("effect"), b: page("effect"), effect: plain("effect") });

    expect(plan.has("effect")).toBe(true);
  });

  it("hands on an import that a module re-exports under another name, and stops where it is declared", () => {
    const plan = planOf(
      viaBarrel("{ Local, Outer }", {
        dropped: true,
        code: `import { Button } from "./button";
const declared = 1;
export { declared as Local };
export { Button as Outer };`,
      }),
    );

    expect(plan.has("button")).toBe(true);
  });

  it("stops at barrels that re-export each other", () => {
    const plan = planOf({
      a: { entry: true, code: `import { missing } from "./loopA";` },
      b: { entry: true, code: `import { missing } from "./loopA";` },
      loopA: { dropped: true, code: `export * from "./loopB";` },
      loopB: { dropped: true, code: `export * from "./loopA";` },
    });

    expect(plan.size).toBe(0);
  });

  it("reads two statements that name the same source as one import", () => {
    const code = `import { x } from "./m"; import { y } from "./m";`;
    const plan = planOf({ a: { entry: true, code }, b: { entry: true, code }, m: plain("m") });

    expect(plan.has("m")).toBe(true);
  });

  it("loads nothing behind an `export *` of a module that the build has no record of", () => {
    const plan = planOf({
      a: { entry: true, code: `import { thing } from "./barrel";` },
      b: { entry: true, code: `import { thing } from "./barrel";` },
      barrel: { dropped: true, code: `export * from "./gone";` },
    });

    expect(plan.size).toBe(0);
  });
});

describe("planChunks: what an entry point hands out", () => {
  it("loads what a route's client file re-exports, and what it re-exports with `export *`", () => {
    const plan = planOf({
      wrapper: {
        entry: true,
        dropped: true,
        exports: ["default", "*"],
        code: `export { default } from "./route"; export * from "./extra";`,
      },
      other: page("route", "extra"),
      route: plain("route"),
      extra: plain("extra"),
    });

    expect(plan.has("route")).toBe(true);
    expect(plan.has("extra")).toBe(true);
  });
});

describe("planChunks: a module whose statements do not line up with Rollup's ids", () => {
  const odd: Fake = { entry: true, code: `import "./p"; import "./q";` };

  it("takes the ids Rollup lists, and only the ones that are modules of the build", () => {
    const plan = planOf({
      odd: { ...odd, unresolved: ["./q"] },
      other: page("p", "q"),
      p: plain("p"),
      q: plain("q"),
    });

    // `q` is not in the list: `odd` is the only page that asks for it.
    expect(plan.has("p")).toBe(true);
    expect(plan.has("q")).toBe(false);
  });

  it("does the same when Rollup lists more ids than the statements name", () => {
    const plan = planOf({
      odd: { entry: true, code: `import "./p";`, extraIds: ["q"] },
      other: page("p", "q"),
      p: plain("p"),
      q: plain("q"),
    });

    expect(plan.has("p")).toBe(true);
    expect(plan.has("q")).toBe(true);
  });

  it("does it for an entry point too, whose exports there is no way to read", () => {
    const plan = planOf({
      odd: { ...odd, unresolved: ["./q"], exports: ["thing"] },
      other: page("p"),
      p: plain("p"),
    });

    expect(plan.has("p")).toBe(true);
  });

  it("does it when the source that Rollup left out is an export", () => {
    const plan = planOf({
      namedExport: { entry: true, code: `export { x } from "./q";`, unresolved: ["./q"] },
      allExport: { entry: true, code: `export * from "./q";`, unresolved: ["./q"] },
      other: page("q"),
      q: plain("q"),
    });

    expect(plan.has("q")).toBe(false);
  });

  it("reads a module that Rollup has no syntax tree of as one that imports nothing", () => {
    const plan = planOf({ bare: { entry: true, noAst: true }, other: page("p"), p: plain("p") });

    expect(plan.size).toBe(0);
  });
});

describe("demoBlindChunks", () => {
  /** What Rollup hands `manualChunks`: the records of the build. */
  function build(fakes: Fakes): {
    getModuleIds: () => IterableIterator<string>;
    getModuleInfo: Rollup.GetModuleInfo;
  } {
    const graph = graphOf(fakes);
    return {
      getModuleIds: vi.fn(() => [...graph.ids()].values()),
      getModuleInfo: (id) => {
        const module = graph.module(id);
        return module === null
          ? null
          : {
              ...module,
              attributes: {},
              code: null,
              dynamicallyImportedIdResolutions: [],
              dynamicallyImportedIds: [],
              exportedBindings: null,
              hasDefaultExport: null,
              id,
              implicitlyLoadedAfterOneOf: [],
              implicitlyLoadedBefore: [],
              importers: [],
              isExternal: false,
              meta: {},
              moduleSideEffects: true,
              safeVariableNames: null,
              syntheticNamedExports: false,
            };
      },
    };
  }

  it("answers with the plan, and plans once for a build however many modules ask", () => {
    const chunks = demoBlindChunks(OPTIONS);
    const first = build(TWO_PAGES);

    expect(chunks("s1", first)).toBe(planOf(TWO_PAGES).get("s1"));
    expect(chunks("s2", first)).toBe(planOf(TWO_PAGES).get("s2"));
    expect(chunks("a", first)).toBeUndefined();
    expect(first.getModuleIds).toHaveBeenCalledTimes(1);
  });

  it("plans again for the next build", () => {
    const chunks = demoBlindChunks(OPTIONS);
    const first = build(TWO_PAGES);
    const second = build(TWO_PAGES);

    chunks("s1", first);
    chunks("s1", second);

    expect(second.getModuleIds).toHaveBeenCalledTimes(1);
  });
});
