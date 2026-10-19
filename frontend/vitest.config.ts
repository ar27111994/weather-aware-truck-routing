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
        // Process entry points (argv/fs wiring and an HTTP listener). Their logic lives in
        // `scripts/tokens/generate.ts` (100% covered); the entries themselves run in CI through
        // `pnpm tokens:check` and in every Playwright run through `pnpm preview`.
        "scripts/build-tokens.ts",
        "scripts/preview.ts",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ["text", "lcov"],
    },
  },
});
