import { describe, expect, it } from "vitest";

import { shellStyles, shipShellStyles } from "./shell-styles.ts";
import type {
  ShellBundle,
  ShellContext,
  ShellStylesOptions,
  ShellStylesPlugin,
} from "./shell-styles.ts";

/** One chunk of a pretend build; `css` are the stylesheet files that Vite recorded for it. */
interface FakeChunk {
  readonly facade?: string | null;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  /** The modules that Rollup put in the chunk. */
  readonly modules?: readonly string[];
  /** Another chunk loads it with `import()`. */
  readonly dynamicEntry?: boolean;
  /** Vite left no record of styles on the chunk. */
  readonly noMetadata?: boolean;
}

/** A pretend Rollup bundle: the chunks by file name, and a stylesheet asset for every `css` name. */
function bundleOf(
  chunks: Readonly<Record<string, FakeChunk>>,
  sources: Readonly<Record<string, string | Uint8Array>> = {},
): ShellBundle {
  const bundle: Record<string, ShellBundle[string]> = {};
  const sheets = new Set<string>();
  for (const [fileName, chunk] of Object.entries(chunks)) {
    const importedCss = new Set(chunk.css ?? []);
    for (const sheet of importedCss) sheets.add(sheet);
    bundle[fileName] = {
      type: "chunk",
      fileName,
      facadeModuleId: chunk.facade === undefined ? null : chunk.facade,
      moduleIds: chunk.modules ?? [],
      isDynamicEntry: chunk.dynamicEntry === true,
      imports: chunk.imports ?? [],
      dynamicImports: chunk.dynamicImports ?? [],
      ...(chunk.noMetadata === true ? {} : { viteMetadata: { importedCss } }),
    };
  }
  for (const sheet of sheets) {
    bundle[sheet] = { type: "asset", fileName: sheet, source: sources[sheet] ?? `/* ${sheet} */` };
  }
  return bundle;
}

const OPTIONS: ShellStylesOptions = {
  name: "planner-shell",
  isRoute: (id) => /\/routes\/home\.tsx(?:\?|$)/u.test(id),
  isLazyEntry: (id) => id.endsWith("/features/planner/PlannerApp.tsx"),
  isAlwaysLoaded: (id) => /\/(?:entry\.client|root)\.tsx(?:\?|$)/u.test(id),
};

/** The `this` of a hook: records what was emitted, and gives the emitted file the name it is shown. */
function context(): ShellContext & {
  readonly emitted: { name: string; source: string }[];
} {
  const emitted: { name: string; source: string }[] = [];
  return {
    emitted,
    emitFile(file) {
      emitted.push({ name: file.name, source: file.source });
      return `ref-${String(emitted.length)}`;
    },
    getFileName: (reference) => `assets/${reference}-HASH.css`,
    error(message) {
      throw new Error(message);
    },
  };
}

/** The usual build: the route, the lazy planner and the code the two share. */
const BUILD: Readonly<Record<string, FakeChunk>> = {
  "assets/entry.client.js": { facade: "C:/p/app/entry.client.tsx", css: ["assets/entry.css"] },
  "assets/root.js": {
    facade: "C:/p/app/root.tsx?__react-router-build-client-route",
    imports: ["assets/entry.client.js"],
    css: ["assets/root.css"],
  },
  "assets/home.js": {
    facade: "C:/p/app/routes/home.tsx?__react-router-build-client-route",
    imports: ["assets/shared-home.js"],
    css: ["assets/home.css"],
  },
  "assets/shared-home.js": { css: ["assets/shared-home.css"] },
  "assets/PlannerApp.js": {
    // The planner is a group of the manual chunks: no module is its facade, and it holds many.
    modules: [
      "C:/p/app/features/planner/PlannerApp.tsx",
      "C:/p/app/features/planner/PlannerPage.tsx",
    ],
    dynamicEntry: true,
    imports: ["assets/Field.js", "assets/shared-home.js", "assets/Chip.js"],
    // The map is loaded when the planner needs it: its styles come with it, not with the shell.
    dynamicImports: ["assets/MapView.js"],
    css: ["assets/PlannerApp.css"],
  },
  "assets/Field.js": { imports: ["assets/Label.js"], css: ["assets/Field.css"] },
  "assets/Label.js": { css: ["assets/Label.css"] },
  "assets/Chip.js": { css: ["assets/Chip.css"] },
  "assets/MapView.js": { css: ["assets/MapView.css"] },
};

/** A build without one of its chunks. */
function without(
  chunks: Readonly<Record<string, FakeChunk>>,
  fileName: string,
): Record<string, FakeChunk> {
  return Object.fromEntries(Object.entries(chunks).filter(([name]) => name !== fileName));
}

describe("shipShellStyles", () => {
  it("writes the styles of the lazy planner's static code as one file that the route lists", () => {
    const bundle = bundleOf(BUILD);
    const here = context();

    shipShellStyles(here, bundle, OPTIONS);

    expect(here.emitted).toHaveLength(1);
    expect(here.emitted[0]?.name).toBe("planner-shell.css");
    const home = bundle["assets/home.js"];
    expect(home?.type === "chunk" ? [...(home.viteMetadata?.importedCss ?? [])] : []).toEqual([
      "assets/home.css",
      "assets/ref-1-HASH.css",
    ]);
  });

  it("puts the styles of what a module imports before the module's own", () => {
    const here = context();

    shipShellStyles(here, bundleOf(BUILD), OPTIONS);

    const written = here.emitted[0]?.source.split("\n") ?? [];
    expect(written).toEqual([
      "/* assets/Label.css */",
      "/* assets/Field.css */",
      "/* assets/Chip.css */",
      "/* assets/PlannerApp.css */",
    ]);
  });

  it("leaves out what the route and the code of every page already list", () => {
    const here = context();

    shipShellStyles(here, bundleOf(BUILD), OPTIONS);

    const written = here.emitted[0]?.source ?? "";
    for (const listed of ["shared-home", "home.css", "root.css", "entry.css"]) {
      expect(written).not.toContain(listed);
    }
  });

  it("leaves out the styles of code that the planner only imports when it needs it", () => {
    const here = context();

    shipShellStyles(here, bundleOf(BUILD), OPTIONS);

    expect(here.emitted[0]?.source).not.toContain("MapView");
  });

  it("lists the file on every chunk of a route that was split", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/home-more.js": {
        facade: "C:/p/app/routes/home.tsx?__react-router-route-chunk=main",
      },
    };
    const bundle = bundleOf(build);

    shipShellStyles(context(), bundle, OPTIONS);

    const more = bundle["assets/home-more.js"];
    expect(more?.type === "chunk" ? [...(more.viteMetadata?.importedCss ?? [])] : []).toEqual([
      "assets/ref-1-HASH.css",
    ]);
  });

  it("reads the backslashes of a Windows path as slashes", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/home.js": { ...BUILD["assets/home.js"], facade: "C:\\p\\app\\routes\\home.tsx" },
    };
    const here = context();

    shipShellStyles(here, bundleOf(build), OPTIONS);

    expect(here.emitted).toHaveLength(1);
  });

  it("reads a stylesheet that Vite kept as bytes", () => {
    const here = context();
    const bytes = new TextEncoder().encode(".a{color:red}");

    shipShellStyles(here, bundleOf(BUILD, { "assets/Chip.css": bytes }), OPTIONS);

    expect(here.emitted[0]?.source).toContain(".a{color:red}");
  });

  it("skips an import that is not a chunk of the bundle", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/Chip.js": { imports: ["https://cdn.example/lib.js"], css: ["assets/Chip.css"] },
    };
    const here = context();

    shipShellStyles(here, bundleOf(build), OPTIONS);

    expect(here.emitted).toHaveLength(1);
  });

  it("walks a chunk that two imports lead to once", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/Chip.js": { imports: ["assets/Label.js"], css: ["assets/Chip.css"] },
    };
    const here = context();

    shipShellStyles(here, bundleOf(build), OPTIONS);

    const written = here.emitted[0]?.source.split("\n") ?? [];
    expect(written.filter((line) => line.includes("Label.css"))).toHaveLength(1);
  });

  it("writes nothing when the planner has no styles that the page lacks", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/PlannerApp.js": { ...BUILD["assets/PlannerApp.js"], imports: [], css: [] },
    };
    const here = context();

    shipShellStyles(here, bundleOf(build), OPTIONS);

    expect(here.emitted).toEqual([]);
  });

  it("stops the build when no chunk is the route", () => {
    const build = without(BUILD, "assets/home.js");

    expect(() => {
      shipShellStyles(context(), bundleOf(build), OPTIONS);
    }).toThrow(/route/u);
  });

  it("stops the build when no chunk is the lazy planner", () => {
    const build = without(BUILD, "assets/PlannerApp.js");

    expect(() => {
      shipShellStyles(context(), bundleOf(build), OPTIONS);
    }).toThrow(/lazy/u);
  });

  it("does not take a chunk that holds the planner's module for the lazy one unless it is loaded with import()", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/PlannerApp.js": { ...BUILD["assets/PlannerApp.js"], dynamicEntry: false },
    };

    expect(() => {
      shipShellStyles(context(), bundleOf(build), OPTIONS);
    }).toThrow(/lazy/u);
  });

  it("stops the build when two chunks are the lazy planner", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/PlannerApp2.js": {
        modules: ["C:\\p\\app\\features\\planner\\PlannerApp.tsx"],
        dynamicEntry: true,
      },
    };

    expect(() => {
      shipShellStyles(context(), bundleOf(build), OPTIONS);
    }).toThrow(/lazy/u);
  });

  it("stops the build when a stylesheet that a chunk lists is not in the bundle", () => {
    const bundle = { ...bundleOf(BUILD) };
    delete (bundle as Record<string, unknown>)["assets/Chip.css"];

    expect(() => {
      shipShellStyles(context(), bundle, OPTIONS);
    }).toThrow(/Chip\.css/u);
  });

  it("stops the build when a stylesheet that a chunk lists is a chunk", () => {
    const bundle = {
      ...bundleOf(BUILD),
      "assets/Chip.css": bundleOf({ "assets/Chip.css": {} })["assets/Chip.css"],
    } as ShellBundle;

    expect(() => {
      shipShellStyles(context(), bundle, OPTIONS);
    }).toThrow(/Chip\.css/u);
  });

  it("stops the build when Vite kept no record of styles on the route", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/home.js": { ...BUILD["assets/home.js"], noMetadata: true },
    };

    expect(() => {
      shipShellStyles(context(), bundleOf(build), OPTIONS);
    }).toThrow(/home\.js/u);
  });

  it("takes a chunk without a record of styles as one without styles", () => {
    const build: Record<string, FakeChunk> = {
      ...BUILD,
      "assets/Chip.js": { noMetadata: true },
    };
    const here = context();

    shipShellStyles(here, bundleOf(build), OPTIONS);

    expect(here.emitted[0]?.source).not.toContain("Chip.css");
  });
});

describe("shellStyles", () => {
  /** What Vite gives `applyToEnvironment`: the part of an environment that the plugin reads. */
  function environment(
    name: string,
  ): Parameters<NonNullable<ShellStylesPlugin["applyToEnvironment"]>>[0] {
    return { name } as Parameters<NonNullable<ShellStylesPlugin["applyToEnvironment"]>>[0];
  }

  it("runs on the client build, after Vite has written its styles and before it lists them", () => {
    const plugin = shellStyles(OPTIONS);

    expect(plugin.name).toBe("haulcast:shell-styles");
    expect(plugin.apply).toBe("build");
    expect(plugin.enforce).toBe("post");
    expect(plugin.applyToEnvironment?.(environment("client"))).toBe(true);
    expect(plugin.applyToEnvironment?.(environment("ssr"))).toBe(false);
  });

  it("writes the styles of the bundle it is given", () => {
    const here = context();

    shellStyles(OPTIONS).generateBundle.call(here, {}, bundleOf(BUILD));

    expect(here.emitted).toHaveLength(1);
  });
});
