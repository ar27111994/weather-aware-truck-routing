import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: the React Router plugin must not run under Vitest.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Every exclusion is listed with its reason; nothing else is excluded.
      exclude: [
        // Test code is not product code.
        "src/**/*.test.{ts,tsx}",
        // Bare hydrateRoot bootstrap: it only runs in a real browser, where the Playwright e2e
        // suite exercises it on every page load.
        "src/entry.client.tsx",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ["text", "lcov"],
    },
  },
});
