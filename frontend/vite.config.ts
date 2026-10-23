import { relative } from "node:path";

import optimizeLocales from "@react-aria/optimize-locales-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, normalizePath } from "vite";

import { demoBlindChunks } from "./scripts/chunking/demo-blind-chunks.ts";

// In development the SPA calls the API on its own origin (`/api/v1/...`), exactly like production
// where Vercel serves both. The proxy forwards to the local Django dev server.
const DJANGO_DEV_SERVER = "http://127.0.0.1:8000";

// Parallel workers share one machine (PROJECT.md section 9), so the dev server owns one port and
// refuses to hop to another when it is taken. T6a owns 5201; `DEV_PORT` overrides it.
const DEV_PORT = Number(process.env["DEV_PORT"] ?? 5201);

// React Aria ships the words of its own controls ("Hour", "Next month", "Clear search") in 35
// languages, and every one of them lands in the bundle: they are 116 kB of the 402 kB (36 of the
// 123 kB gzipped) of the chunk that holds the date, time, number and list controls (N1). The app
// writes its copy in English only, so an interface that mixed in a German "Stunde" would be wrong
// anyway. Only these locales keep their strings; any other browser language falls back to the
// first of them. What the visitor's language still decides is how a clock reads (24-hour or
// AM/PM), the month names and the order of the segments: those come from the browser's own `Intl`,
// not from these strings (D-28; `e2e/locale.spec.ts` pins it).
const SHOWN_LOCALES = ["en-US"];

// D-35 made every demo of `/design` (`components/<Name>/<Name>.demo.tsx`) a lazy entry point of
// its own, and Rollup cuts the shared code of every page along the 40 of them: the first load of
// `/` went from 22 to 42 files and from 171.5 to 179.0 kB gzipped (P1). `demoBlindChunks`
// (scripts/chunking/demo-blind-chunks.ts) names the groups of that code as if the demos were one
// entry point. `onlyExplicitManualChunks` keeps a group to the modules it names, and does not drag
// in what they import (Rollup 5 makes that the default and marks the option deprecated: drop it
// with that upgrade). The client build only: the server build is thrown away after the prerender.
const PROJECT = import.meta.dirname;
const demoBlind = demoBlindChunks({
  isDemo: (id) => id.endsWith(".demo.tsx"),
  // The client entry and the root route, which React Router loads on every page.
  isAlwaysLoaded: (id) => /\/app\/(?:entry\.client|root)\.tsx(?:\?|$)/u.test(normalizePath(id)),
  // The same name on every machine, so that a group has the same name in CI and here.
  nameOf: (id) => normalizePath(relative(PROJECT, id)),
});

export default defineConfig({
  plugins: [{ ...optimizeLocales.vite({ locales: SHOWN_LOCALES }), enforce: "pre" }, reactRouter()],
  environments: {
    client: {
      build: {
        rollupOptions: { output: { manualChunks: demoBlind, onlyExplicitManualChunks: true } },
      },
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: { "/api": DJANGO_DEV_SERVER },
  },
});
