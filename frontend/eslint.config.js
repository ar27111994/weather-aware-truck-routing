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
    // `list-style: none` takes the list semantics away in Safari with VoiceOver, so a list that is
    // styled that way names its role again. That is not redundant here (ProgressSteps).
    files: ["**/*.tsx"],
    rules: { "jsx-a11y/no-redundant-roles": ["error", { ol: ["list"], ul: ["list"] }] },
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
    // D-61: the layers import downward only. The style guide (app/design-system) sits below the
    // features and the routes, and lib sits below the style guide's components: lib may read the
    // style guide's foundation (its tokens and strings), the lowest layer, and nothing above it.
    // Text that a style guide demo and a feature both need lives in lib. This is ESLint's own rule
    // and not the typescript-eslint one above: a second block for that rule would replace the zod
    // restriction for these folders, and D-61 has to report `import type` too. The rule reads
    // `import` and `export ... from`; it does not look at `import()`.
    files: ["app/design-system/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?:\\.\\./)+(?:features|routes)(?:\\.tsx?)?(?:/|$)",
              message:
                "The style guide imports nothing from a feature or a route (D-61). Put the code that both need in app/lib.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?:\\.\\./)+(?:(?:features|routes)(?:\\.tsx?)?|design-system/components)(?:/|$)",
              message:
                "lib imports nothing from a feature, a route or a style guide component (D-61). It may import app/design-system/foundation.",
            },
          ],
        },
      ],
    },
  },
  {
    // `const done = page.evaluate(...)` sends the script and carries on without waiting for it to
    // run. A script that has to be in place before an action (a listener, say) can then be added
    // after the action, miss the event the action causes, and leave the test waiting for an event
    // that was already sent: the chromium flake of overlays.spec.ts. Await the evaluation, and keep
    // what the page has to hand back in a handle: `const handle = await page.evaluateHandle(...)`.
    files: ["e2e/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "VariableDeclarator > CallExpression[callee.property.name=/^evaluate(Handle)?$/]",
          message:
            "Await the evaluation before the next action: a script that is still in flight can run after it. Keep what the page must hand back in a handle (await page.evaluateHandle).",
        },
      ],
    },
  },
  {
    // A test file keeps no copy of installFakeTimers (it stubs the `jest` global that Testing
    // Library needs to find a faked clock) or of Controlled: both live in test/ (R3-20).
    files: ["app/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='stubGlobal'][arguments.0.value='jest']",
          message:
            "Call installFakeTimers() from test/fake-timers.ts: it stubs the jest global too.",
        },
        {
          selector:
            "FunctionDeclaration[id.name='Controlled'], VariableDeclarator[id.name='Controlled']",
          message: "Import Controlled from test/controlled.tsx instead of writing a local copy.",
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
