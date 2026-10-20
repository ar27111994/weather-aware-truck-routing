import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: the React Router plugin must not run under Vitest.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "scripts/**/*.ts"],
      // Every exclusion is listed with its reason; nothing else is excluded.
      exclude: [
        // Test code is not product code.
        "app/**/*.test.{ts,tsx}",
        "scripts/**/*.test.ts",
        // Bare hydrateRoot bootstrap: it only runs in a real browser, where the Playwright e2e
        // suite exercises it on every page load.
        "app/entry.client.tsx",
        // Process entry points: top-level code that hands `process.argv`, `node:fs`, the console
        // and `process.exit` to modules that hold every rule and branch (`scripts/tokens/cli.ts`,
        // `scripts/tokens/generate.ts`, `scripts/preview/server.ts`), all covered at 100%. Nothing
        // in the entries can be tested without starting a process; CI runs them for real: `pnpm
        // tokens:check` in the frontend job and `pnpm preview` under every Playwright project.
        "scripts/build-tokens.ts",
        "scripts/preview.ts",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ["text", "lcov"],
    },
  },
});
