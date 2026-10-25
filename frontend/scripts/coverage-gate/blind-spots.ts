import { readFileSync } from "node:fs";
import { relative } from "node:path";

import ts from "typescript";
import type { Reporter } from "vitest/node";

/*
 * Files that the coverage gate cannot see (RT-F3).
 *
 * Vitest's v8 provider counts statements in the code that Vite's SSR transform makes of a module,
 * and it drops, on purpose, the statements the transform adds for exports: `export default
 * <expression>` becomes `const __vite_ssr_export_default__ = <expression>`, and the provider
 * ignores that declarator (`@vitest/coverage-v8` provider.js, the `ignoreNode` rules for SSR
 * exports). A file whose only code is that expression has no statement and no line, and with no
 * function or condition inside it nothing else to count: the gate reads 0 of 0, and stays at 100 %
 * whether or not a test loads the file. `app/routes.ts` was such a file. Its row of the coverage
 * table prints `0 | 0 | 0 | 0`, as the barrels and the interface-only files do that have nothing to
 * measure, because the text reporter prints every file with no lines that way.
 *
 * This reporter tells the two kinds apart. After a run Vitest hands it the coverage data
 * (`onCoverage`). For each file with no counted statement it asks the TypeScript compiler whether
 * the file has code: anything but imports, re-exports and type-only declarations. A file with code
 * and no counted statement fails the run, the way a missed threshold does. It is a reporter, not a
 * script after the run, so that it sees the data whichever coverage reporters the command line
 * names (CI replaces the configured ones) and needs no entry point that the gate would have to
 * leave out of its own measure.
 */

/** The part of Vitest's coverage data (an Istanbul `CoverageMap`) that the check reads. */
export interface CoverageData {
  /** The absolute paths of the files that the data lists. */
  readonly files: () => string[];
  /** The coverage of one of them. */
  readonly fileCoverageFor: (file: string) => {
    readonly toSummary: () => { readonly statements: { readonly total: number } };
  };
}

/** The part of Vitest that the reporter uses. */
export interface ReporterHost {
  /** The resolved config of the run. */
  readonly config: { readonly root: string };
  /** Where Vitest prints its own errors, such as a missed threshold. */
  readonly logger: { error(message: string): void };
}

/** The names that a file imports, as a statement can use them again: `export default <name>`. */
function importedNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const { name, namedBindings } = statement.importClause;
    if (name !== undefined) names.add(name.text);
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      names.add(namedBindings.name.text);
    } else {
      for (const element of namedBindings.elements) names.add(element.name.text);
    }
  }
  return names;
}

/** `declare const x: number;`, `declare module "m" {}`: a description of code that is elsewhere. */
function isAmbient(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    )
  );
}

/** Whether a top-level statement is code, or only an import, a re-export or a type. */
function isCode(statement: ts.Statement, imported: ReadonlySet<string>): boolean {
  if (
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    isAmbient(statement)
  ) {
    return false;
  }
  // An overload signature has no body; only its implementation is code.
  if (ts.isFunctionDeclaration(statement)) return statement.body !== undefined;
  // `export default Foo;` re-exports `Foo` when the file imported it; any other expression is code.
  if (ts.isExportAssignment(statement)) {
    return !(ts.isIdentifier(statement.expression) && imported.has(statement.expression.text));
  }
  return true;
}

/**
 * Whether a source file has code that a test can run: any top-level statement but an import, a
 * re-export, a type-only declaration or an interface. The file name picks the dialect (`.tsx`).
 */
export function hasExecutableCode(fileName: string, source: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const imported = importedNames(sourceFile);
  return sourceFile.statements.some((statement) => isCode(statement, imported));
}

/**
 * The files that the coverage data lists with no counted statement although they have code, in
 * name order. `readSource` is asked only about the files with no statement.
 */
export function findBlindSpots(
  coverage: CoverageData,
  readSource: (file: string) => string,
): string[] {
  return coverage
    .files()
    .filter((file) => coverage.fileCoverageFor(file).toSummary().statements.total === 0)
    .filter((file) => hasExecutableCode(file, readSource(file)))
    .toSorted();
}

/** The error that names the blind spots from the project root, and says what to do about them. */
export function describeBlindSpots(files: readonly string[], root: string): string {
  return [
    "ERROR: The coverage data lists no statements for a file that has code (RT-F3):",
    ...files.map((file) => `  ${relative(root, file).replaceAll("\\", "/")}`),
    "Vitest's v8 provider does not count `export default <expression>`, so code that is only that is",
    "never measured, whether or not a test loads it. Write `const name = <expression>;` and then",
    "`export default name;`: the constant is a statement of its own.",
  ].join("\n");
}

/** Whether Vitest handed over coverage data that the check can read. */
export function isCoverageData(value: unknown): value is CoverageData {
  return (
    typeof value === "object" &&
    value !== null &&
    "files" in value &&
    typeof value.files === "function" &&
    "fileCoverageFor" in value &&
    typeof value.fileCoverageFor === "function"
  );
}

/** The source of a file, as the check reads it. */
function readUtf8(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * A Vitest reporter (vitest.config.ts lists it) that fails the run when the coverage data lists a
 * file with code and no statements. A shape it does not know, or a file it cannot read, fails the
 * run too: a check that cannot look must not pass.
 */
export default class BlindSpotReporter implements Reporter {
  private host!: ReporterHost;

  /** Vitest calls it first, with itself. */
  onInit(host: ReporterHost): void {
    this.host = host;
  }

  /** Vitest calls it once the run is over, with the coverage data, before it checks thresholds. */
  onCoverage(coverage: unknown): void {
    if (!isCoverageData(coverage)) {
      this.fail(
        "ERROR: The coverage data has a shape this check does not know, so it could not look for files with code and no statements.",
      );
      return;
    }
    let blindSpots: string[];
    try {
      blindSpots = findBlindSpots(coverage, readUtf8);
    } catch (error) {
      this.fail(
        `ERROR: The check for files with code and no statements could not run: ${String(error)}`,
      );
      return;
    }
    if (blindSpots.length > 0) this.fail(describeBlindSpots(blindSpots, this.host.config.root));
  }

  /** Prints the error the way a missed threshold is printed, and fails the process. */
  private fail(message: string): void {
    this.host.logger.error(message);
    process.exitCode = 1;
  }
}
