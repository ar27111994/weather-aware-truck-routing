import type { Plugin } from "vite";

/*
 * The styles of the planner that the prerendered page draws, in the page that draws it.
 *
 * The planner's code is a lazy chunk (N1, D-46): it loads when the visitor first gives the page an
 * input. Vite ties a stylesheet to the chunk whose modules import it, so the styles of everything
 * the planner draws came with that chunk. But the page draws the planner before its code is there,
 * as markup (the prerender, and for a visit that arrives by navigating inside the app the shell
 * read from the prerender). Until the code loaded, 61 of the 74 classes of that markup had no
 * rule: the first paint of `/` was a form without its panel, grid, fields or hidden spinner, and
 * the first input drew everything again, in place, with a jump (R4-01: 0.5 to 1.0 layout shift on
 * the client navigation to `/`, in the trace of CI run 39950114313).
 *
 * The page's own stylesheets are the ones its route lists, and React Router both links them in the
 * prerendered page and holds a client navigation until they have arrived. So the styles that the
 * markup needs are listed by the route: the styles of the planner's static code (what it imports
 * without `import()`, so not the map, nor the results) that no page already has, written as one
 * file so that the first paint pays one request, not twenty.
 */

/** A stylesheet that Vite wrote, or a chunk of code: the part of a Rollup bundle that this file reads. */
export type ShellBundle = Readonly<Record<string, ShellChunk | ShellAsset>>;

/** The part of a chunk of code that this file reads. */
export interface ShellChunk {
  readonly type: "chunk";
  readonly fileName: string;
  /** The module the chunk was made for; React Router asks for its routes with a query on it. */
  readonly facadeModuleId: string | null;
  /** Every module that Rollup put in the chunk: a group of the manual chunks has no facade. */
  readonly moduleIds: readonly string[];
  /** Another chunk loads this one with `import()`. */
  readonly isDynamicEntry: boolean;
  /** The chunks it imports with `import` statements; they are loaded with it. */
  readonly imports: readonly string[];
  /** The chunks it imports with `import()`; they are loaded when it needs them, and not followed. */
  readonly dynamicImports?: readonly string[];
  /** What Vite recorded of it; the stylesheets that the page of this chunk must link. */
  readonly viteMetadata?: { readonly importedCss: Set<string> } | undefined;
}

/** A file that is not code: here, a stylesheet. */
export interface ShellAsset {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

/** What differs from one project to the next. */
export interface ShellStylesOptions {
  /** The name of the stylesheet that is written (`planner-shell` makes `planner-shell-<hash>.css`). */
  readonly name: string;
  /** Whether a module is the route whose page draws the shell; its chunk is made to list the file. */
  readonly isRoute: (id: string) => boolean;
  /** Whether a module is the lazy chunk's entry point, the code that takes the shell over. */
  readonly isLazyEntry: (id: string) => boolean;
  /** Whether a module is loaded by every page (the client entry, the root route): its styles are there. */
  readonly isAlwaysLoaded: (id: string) => boolean;
}

/** What {@link shipShellStyles} needs of Rollup's `this` in a hook. */
export interface ShellContext {
  emitFile(file: { type: "asset"; name: string; source: string }): string;
  getFileName(reference: string): string;
  error(message: string): never;
}

/** The chunks of a bundle. */
function chunksOf(bundle: ShellBundle): ShellChunk[] {
  return Object.values(bundle).filter((item): item is ShellChunk => item.type === "chunk");
}

/** An id as the options read it: with slashes, whatever the system, and the query left on. */
function slashed(id: string): string {
  return id.replaceAll("\\", "/");
}

/** The chunks that are the entry point of a module that `matches`. */
function entriesFor(chunks: readonly ShellChunk[], matches: (id: string) => boolean): ShellChunk[] {
  return chunks.filter(
    ({ facadeModuleId }) => facadeModuleId !== null && matches(slashed(facadeModuleId)),
  );
}

/**
 * The chunks that hold a module that `matches` and that another chunk loads with `import()`. The
 * planner's chunk is a group of the manual chunks, so no module is its facade: it is found by what
 * it holds.
 */
function lazyChunksFor(
  chunks: readonly ShellChunk[],
  matches: (id: string) => boolean,
): ShellChunk[] {
  return chunks.filter(
    ({ isDynamicEntry, moduleIds }) =>
      isDynamicEntry && moduleIds.some((id) => matches(slashed(id))),
  );
}

/** The stylesheets Vite recorded for a chunk; none where it recorded nothing. */
function stylesOf(chunk: ShellChunk): readonly string[] {
  return [...(chunk.viteMetadata?.importedCss ?? [])];
}

/**
 * The chunks that load with `entries`, the way the browser loads them: through `import` statements
 * only, each chunk once, what a chunk imports before the chunk itself.
 */
function staticChunks(bundle: ShellBundle, entries: readonly ShellChunk[]): ShellChunk[] {
  const seen = new Set<string>();
  const ordered: ShellChunk[] = [];
  const visit = (chunk: ShellChunk): void => {
    if (seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const file of chunk.imports) {
      const imported = bundle[file];
      // A chunk that is not in the bundle (an external module) has no styles to follow.
      if (imported?.type === "chunk") visit(imported);
    }
    ordered.push(chunk);
  };
  for (const entry of entries) visit(entry);
  return ordered;
}

/** The text of a stylesheet of the bundle. */
function textOf(context: ShellContext, bundle: ShellBundle, fileName: string): string {
  const asset = bundle[fileName];
  if (asset?.type !== "asset") {
    return context.error(
      `The stylesheet ${fileName} is listed by a chunk and is not in the bundle.`,
    );
  }
  return typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
}

/**
 * Writes the styles of the lazy chunk's static code that the page of the route does not have as one
 * stylesheet, and makes the route list it. It stops the build when the route or the lazy chunk is
 * not there, so that a rename cannot undo this without a sound.
 *
 * @param context - Rollup's `this` in `generateBundle`.
 * @param bundle - The chunks and files of the build.
 * @param options - What names the route and the lazy chunk.
 */
export function shipShellStyles(
  context: ShellContext,
  bundle: ShellBundle,
  options: ShellStylesOptions,
): void {
  const chunks = chunksOf(bundle);
  const routes = entriesFor(chunks, options.isRoute);
  if (routes.length === 0)
    context.error("No chunk of the bundle is the route that draws the shell.");
  const lazy = lazyChunksFor(chunks, options.isLazyEntry);
  const [planner, ...others] = lazy;
  if (planner === undefined || others.length > 0) {
    context.error(
      `Expected one lazy chunk that takes the shell over, found ${String(lazy.length)}.`,
    );
  }

  // The page already has the styles of its route and of the code every page loads.
  const present = new Set(
    staticChunks(bundle, [...routes, ...entriesFor(chunks, options.isAlwaysLoaded)]).flatMap(
      stylesOf,
    ),
  );
  const shell = [
    ...new Set(
      staticChunks(bundle, [planner])
        .flatMap(stylesOf)
        .filter((file) => !present.has(file)),
    ),
  ];
  if (shell.length === 0) return;

  const source = shell.map((file) => textOf(context, bundle, file)).join("\n");
  const written = context.getFileName(
    context.emitFile({ type: "asset", name: `${options.name}.css`, source }),
  );
  for (const route of routes) {
    if (route.viteMetadata === undefined) {
      context.error(`Vite recorded no styles for ${route.fileName}, so it cannot list ${written}.`);
    }
    route.viteMetadata.importedCss.add(written);
  }
}

/** The plugin: only the client build has a page that draws the shell. */
export type ShellStylesPlugin = Omit<Plugin, "generateBundle"> & {
  generateBundle(this: ShellContext, options: object, bundle: ShellBundle): void;
};

/**
 * The plugin around {@link shipShellStyles}. It runs after Vite has written the styles of every
 * chunk and before Vite lists them in its manifest, which React Router reads for the styles of a
 * route.
 *
 * @param options - What names the route and the lazy chunk.
 */
export function shellStyles(options: ShellStylesOptions): ShellStylesPlugin {
  return {
    name: "haulcast:shell-styles",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_output, bundle) {
      shipShellStyles(this, bundle, options);
    },
  };
}
