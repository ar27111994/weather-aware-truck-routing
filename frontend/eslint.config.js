import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "build/**",
      ".react-router/**",
      ".css-modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    // Lint-suppression comments are banned project-wide (PROJECT.md): turning inline config off
    // makes `eslint-disable` a no-op, and a stale directive is reported rather than ignored.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  jsxA11y.flatConfigs.strict,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Zod 4 probes `new Function` when the first object schema is created, and the strict CSP
    // reports that probe as a violation. app/api/zod.ts turns the probe and the compiler off before
    // any schema exists, so runtime imports of Zod go through it; type-only imports are free.
    files: ["**/*.{ts,tsx}"],
    ignores: ["app/api/zod.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "zod",
              message: "Import z from app/api/zod.ts, which keeps Zod from compiling code (CSP).",
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ["zod/*"],
              message: "Import z from app/api/zod.ts, which keeps Zod from compiling code (CSP).",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JS files (this config) are outside the TypeScript project, so no type information.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
);
