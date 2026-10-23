# Demo-blind chunks: the style guide does not tax the production pages

Status: accepted (D-48). Applies to the client build: `vite.config.ts` and `scripts/chunking/`.

## Context

D-35 made each of the 40 demos of the style guide (`components/<Name>/<Name>.demo.tsx`) a lazy entry
point of its own, so that `/design?section=TextField` loads one demo and not forty. Rollup puts every
shared module in the chunk that is named by the set of entry points that load it, and each demo
reaches another part of the design system. So the shared code of every page was cut along 40 lines
that no production page crosses.

On `e560de5` the first load of `/` was 42 files and 178,975 bytes gzipped. The same app with all 40
demos behind ONE lazy chunk (a measurement-only variant, never built for release) was 22 files and
171,510 bytes. Every script of a first load is a modulepreload that the first paint waits for, so the
20 extra files add to the render delay, which was 89% of the 4.06 s LCP of `/` that D-46 measured on
CI (item 1).

## Root cause

From the bundle graph of the client build (Rollup's own record of every chunk, its modules and its
importers): of the 41 Rollup chunks of `/`, 26 were named by a part of the demos (1 to 39 of them) and
held 36,855 gzipped bytes between them, one by all 40 demos (React Aria's `VisuallyHidden`, 13,967
bytes) and 14 by none. `strings` was named by 26 demos, the button by 19, the overlay state by 11.
`/methodology` had 31 such chunks and the SPA fallback 26. The 42nd file of `/` is React Router's
`manifest-*.js`, which is written outside Rollup. This is Rollup's documented rule at work, and this
is its measured size.

## Decision

`demoBlindChunks` (`scripts/chunking/demo-blind-chunks.ts`) is the `manualChunks` of the client
build, with `onlyExplicitManualChunks` so that a group holds the modules it names and not what they
import (Rollup 5 makes that the default and marks the option deprecated: drop it with that
upgrade). It names the groups itself, and it counts every demo as ONE entry point more, the way a
single lazy chunk would, so the groups are the same whatever the number of demos.

- A **root** is an entry point of the build, or a lazy chunk (the target of an `import()`) that is not
  a demo. For each root the plan works out what loading it loads: its static imports, followed through
  the barrels the way tree shaking does. An import loads the module that _declares_ the imported
  binding, not the other modules of the barrel. Following the import statements alone put 94 kB of
  unused React Aria in the first load of `/`.
- For a lazy root the plan works out what is in memory when it loads (what every page that loads it has
  loaded before), because Rollup does not count a lazy entry point for such a module.
- A module of the first load that more than one root loads, or that a demo also reaches, goes to a
  group named after the roots that load it (`shared-` and 8 hex digits of a hash of their paths
  relative to the project, so the name is the same on every machine). A module that one root alone
  loads and no demo reaches stays where Rollup puts it, and so does everything only a demo reaches.
- When no page loads all of a group, the modules that a demo reaches are kept apart from the others
  that the same roots load, so a demo that needs one module of the group does not download the rest.
- Each demo keeps a chunk of its own: D-35 holds, and `/design?section=Name` loads that demo and the
  shared code it needs.

`INITIAL_JS_FILE_BUDGETS` (`scripts/perf/initial-js.ts`) is the guard. N1 counts bytes, and the room
that this change gives back under 180,000 is about as big as the tax was, so the bytes alone would
let the tax return unseen. Each page also has a budget of script files, the count of the same app
without the tax: 22 for `/`, 26 for `/methodology`, 18 for the SPA fallback. `e2e/bundle-budget.spec.ts`
asserts it next to the bytes. With the chunking taken out of `vite.config.ts` the three checks fail
(42, 46 and 38 files).

## Why not the obvious ways

Every variant was built on `e560de5` and measured with the D-45 method (chromium, gzip level 6,
every script from the start of the navigation to 2 s after the load event, MapLibre excluded).
Files · gzipped bytes:

| Variant                                                       | `/`          | `/methodology` | SPA fallback | `/design?section=TextField`    | `/` after one input |
| ------------------------------------------------------------- | ------------ | -------------- | ------------ | ------------------------------ | ------------------- |
| Before                                                        | 42 · 178,975 | 46 · 179,767   | 38 · 171,617 | 49 · 182,542                   | 107 · 343,169       |
| All 40 demos behind one lazy chunk (measurement only)         | 22 · 171,510 | 26 · 173,802   | 18 · 165,356 | (the whole page: 31 · 302,974) | 31 · 312,140        |
| `experimentalMinChunkSize` 3,000                              | 29 · 181,781 | 32 · 183,313   | 26 · 175,547 | 30 · 184,771                   | 69 · 339,062        |
| `experimentalMinChunkSize` 10,000                             | 25 · 182,519 | 28 · 184,204   | 23 · 176,630 | 25 · 184,241                   | 59 · 337,064        |
| `experimentalMinChunkSize` 20,000                             | 24 · 181,423 | 27 · 183,130   | 22 · 175,523 | 25 · 185,897                   | 58 · 338,044        |
| `manualChunks` on the import statements                       | 26 · 273,237 | 27 · 274,006   | 22 · 266,999 | 29 · 312,423                   | 31 · 335,313        |
| `manualChunks` on tree-shaken imports, every root             | 19 · 170,733 | 22 · 173,010   | 15 · 164,562 | 26 · 289,542                   | 27 · 311,516        |
| **`demoBlindChunks`: the first load's roots (this decision)** | 19 · 171,738 | 23 · 173,084   | 15 · 164,560 | 25 · 178,193                   | 74 · 332,625        |

- **`experimentalMinChunkSize`** merges small chunks by size, not by who loads them: it merges
  unrelated code, and every page downloads more bytes than before (181 to 185 kB on `/`).
- **`manualChunks` on the import statements** counts a barrel's every re-export as loaded by whoever
  imports the barrel: `/` downloads 273 kB.
- **Tree-shaken imports for every root, the lazy planner too** also cuts the cost after the first
  input (27 files, 311.5 kB), but a demo then has to download the planner's groups that it needs one
  module of: `/design?section=TextField` is 289.5 kB where it was 182.5 kB. D-35 exists so that a page
  of one section stays light (the iPhone 14 end-to-end runs depend on it), so this variant was not
  taken.
- **All the demos behind one lazy chunk** is the no-tax baseline, and every section page then downloads
  all 40 demos (302,974 bytes for any section): it is what D-35 removed.

## Consequences

- The first load of `/`, `/methodology` and the SPA fallback is at or near the same app without the tax
  and well under what it was before. Against that baseline (allowance +1,024 bytes): `/` is 228 bytes
  over it, `/methodology` 718 bytes under, the SPA fallback 796 bytes under. Against the numbers
  before: 7.2, 6.7 and 7.1 kB less, and 23 files fewer on each page.
- The code that only a lazy chunk loads (the planner's, the results) is left to Rollup, so it keeps
  part of the split: `/` after one input is 74 files where the baseline is 31. It is 107 files and
  343,169 bytes before this change (D-46 3.5(c), D-49): the cap went down with it.
- A new page, route or lazy chunk needs nothing: the plan reads the graph of the build. A demo is
  recognised by its name (`*.demo.tsx`), and the root route and the client entry are the files every
  page loads (`isDemo` and `isAlwaysLoaded` in `vite.config.ts`).
- The plan follows Rollup's rule for what a lazy entry point finds already loaded, as a second
  implementation of it. The unit tests (`demo-blind-chunks.test.ts`) pin each behaviour on pretend
  builds, with real syntax trees, and the file budgets pin the result on the real build. A Rollup
  upgrade that changes the rule shows up as a changed file count.
- A change of bundler (Vite's move to Rolldown, say) has its own chunk options. It will have to carry
  this decision over, and the file budgets are the check that it did.
