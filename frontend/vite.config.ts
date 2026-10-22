import optimizeLocales from "@react-aria/optimize-locales-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

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

export default defineConfig({
  plugins: [{ ...optimizeLocales.vite({ locales: SHOWN_LOCALES }), enforce: "pre" }, reactRouter()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: { "/api": DJANGO_DEV_SERVER },
  },
});
