import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guard for the WORKAROUND on `SearchAnnouncer` in `ComboBox.tsx` (R3-25). The combo box's live
 * region carries `data-live-announcer`, a private React Aria mark, so that React Aria leaves it
 * exposed while the list is open. React Aria's aria-modal polyfill (`watchModals`) exposes only
 * the first `[data-live-announcer="true"]` element next to a modal. This app does not use it; if
 * it ever does, the combo box's region could displace React Aria's own announcer. So the build
 * fails when a file under `app/` imports the polyfill, and the failure points back to that note.
 */

const APP = join(import.meta.dirname, "../../..");

const POLYFILL = "aria-modal-polyfill";
const WATCH_MODALS = "watchModals";

const HAZARD =
  `A file under app/ imports React Aria's aria-modal polyfill (${WATCH_MODALS}). The polyfill keeps ` +
  `only the FIRST [data-live-announcer="true"] element exposed next to a modal, and the combo ` +
  `box's live region carries that private mark as a workaround, so it could displace React ` +
  `Aria's own announcer. Read "WORKAROUND (private React Aria mark)" on SearchAnnouncer in ` +
  `app/design-system/components/ComboBox/ComboBox.tsx before you add this import.`;

/** Every `.ts` and `.tsx` file below `directory`. */
function sourcesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourcesIn(path);
    }
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** The module path of an import or a re-export, or of a `require()` or dynamic `import()` call. */
function modulePath(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node)) {
    const [argument] = node.arguments;
    const loadsModule =
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require");
    return loadsModule && argument !== undefined && ts.isStringLiteralLike(argument)
      ? argument.text
      : undefined;
  }
  return undefined;
}

/** The names that an import or a re-export takes from its module. */
function takenNames(node: ts.Node): string[] {
  const bindings = ts.isImportDeclaration(node)
    ? node.importClause?.namedBindings
    : ts.isExportDeclaration(node)
      ? node.exportClause
      : undefined;
  if (bindings === undefined || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
    return [];
  }
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

/**
 * Whether `text` imports the polyfill: a module path with `aria-modal-polyfill` in it
 * (`@react-aria/aria-modal-polyfill`, `react-aria/private/aria-modal-polyfill/...`) or the name
 * `watchModals` taken from any module, by an import, a re-export, `import()` or `require()`.
 * Comments, strings and prose that only name the polyfill are not imports.
 */
function importsModalPolyfill(text: string): boolean {
  const file = ts.createSourceFile(
    "source.tsx",
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    found ||=
      (modulePath(node)?.includes(POLYFILL) ?? false) || takenNames(node).includes(WATCH_MODALS);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every source file of the app, by its path below `app/`, with its text. */
const SOURCES: ReadonlyMap<string, string> = new Map(
  sourcesIn(APP).map((path) => [
    relative(APP, path).replaceAll("\\", "/"),
    readFileSync(path, "utf8"),
  ]),
);

describe("the combo box's live region and React Aria's aria-modal polyfill (R3-25)", () => {
  it("is not exposed to the polyfill: no file under app/ imports it", () => {
    expect(SOURCES.size).toBeGreaterThan(100);

    const importers = [...SOURCES]
      .filter(([, text]) => importsModalPolyfill(text))
      .map(([name]) => name);

    expect(importers, HAZARD).toEqual([]);
  });

  describe("the scan", () => {
    it.each([
      [
        "a named import from the polyfill package",
        `import { ${WATCH_MODALS} } from "@react-aria/${POLYFILL}";`,
      ],
      ["a side-effect import of the package", `import "@react-aria/${POLYFILL}";`],
      [
        "an import of its path inside react-aria",
        `import { ${WATCH_MODALS} as watch } from "react-aria/private/${POLYFILL}/ariaModalPolyfill";`,
      ],
      ["the name taken from another module", `import { ${WATCH_MODALS} } from "react-aria";`],
      ["a re-export of the name", `export { ${WATCH_MODALS} } from "./somewhere";`],
      ["a dynamic import", `const load = () => import("@react-aria/${POLYFILL}");`],
      ["a require call", `const polyfill = require("@react-aria/${POLYFILL}");`],
    ])("finds %s", (_name, sample) => {
      expect(importsModalPolyfill(sample)).toBe(true);
    });

    it.each([
      [
        "prose in a comment",
        `/** The polyfill (${WATCH_MODALS}) is not used. */\nimport { useComboBox } from "react-aria";`,
      ],
      [
        "a commented-out import",
        `// import { ${WATCH_MODALS} } from "@react-aria/${POLYFILL}";\nexport const x = 1;`,
      ],
      [
        "a string that names it",
        `export const note = "${WATCH_MODALS} from @react-aria/${POLYFILL}";`,
      ],
      [
        "an unrelated import",
        `import { useComboBox } from "react-aria";\nimport "./ComboBox.module.css";`,
      ],
      ["a name that only contains it", `import { ${WATCH_MODALS}Helper } from "./helper";`],
      ["a call that loads nothing", `const value = load("@react-aria/${POLYFILL}");`],
    ])("ignores %s", (_name, sample) => {
      expect(importsModalPolyfill(sample)).toBe(false);
    });
  });
});
