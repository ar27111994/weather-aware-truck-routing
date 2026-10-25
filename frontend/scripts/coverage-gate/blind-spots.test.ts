// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import config from "../../vitest.config.ts";
import BlindSpotReporter, {
  describeBlindSpots,
  findBlindSpots,
  hasExecutableCode,
  isCoverageData,
} from "./blind-spots.ts";
import type { CoverageData, ReporterHost } from "./blind-spots.ts";

/** `app/routes.ts` as the gate found it: one statement, `export default <expression>`. */
const ROUTES = [
  'import { index, route } from "@react-router/dev/routes";',
  "",
  "export default [",
  '  index("routes/home.tsx"),',
  '  route("methodology", "routes/methodology.tsx"),',
  "];",
  "",
].join("\n");

/** The coverage data of a run: each file with the number of statements the provider counted. */
function coverageOf(statementsByFile: ReadonlyMap<string, number>): CoverageData {
  return {
    files: () => [...statementsByFile.keys()],
    fileCoverageFor: (file) => ({
      toSummary: () => ({ statements: { total: statementsByFile.get(file) ?? 0 } }),
    }),
  };
}

/** A source reader over a few files; it fails for a file nobody listed. */
function sourcesOf(sources: ReadonlyMap<string, string>): (file: string) => string {
  return (file) => {
    const source = sources.get(file);
    if (source === undefined) throw new Error(`no source for ${file}`);
    return source;
  };
}

describe("hasExecutableCode", () => {
  it.each([
    [
      "a barrel of re-exports",
      'export { a } from "./a";\nexport * from "./b";\nexport * as c from "./c";\nexport type { T } from "./t";\n',
    ],
    ["an empty export list", "export {};\n"],
    [
      "imports",
      'import "./side-effect";\nimport { x } from "./x";\nimport type { Y } from "./y";\n',
    ],
    ["an interface", "export interface Shape {\n  readonly side: number;\n}\n"],
    ["a type alias", "export type Id = string | number;\n"],
    [
      "ambient declarations",
      'declare const version: string;\ndeclare function load(): void;\ndeclare module "x" {\n  export const y: number;\n}\n',
    ],
    ["an import-equals", 'import fs = require("node:fs");\n'],
    [
      "overload signatures",
      "export function pick(a: string): string;\nexport function pick(a: number): number;\n",
    ],
    ["an empty file", ""],
    ["comments", "// nothing to run here\n"],
  ])("finds no code in %s", (_name, source) => {
    expect(hasExecutableCode("app/file.ts", source)).toBe(false);
  });

  it.each([
    ["the route list of app/routes.ts", ROUTES],
    ["a constant", "export const limit = 3;\n"],
    ["a local constant", "const local = 1;\n"],
    ["a function", "export function load(): number {\n  return 1;\n}\n"],
    ["a class", "export class Cache {}\n"],
    ["an enum", "export enum Mode {\n  Fast,\n}\n"],
    ["a statement", "register();\n"],
    ["a default export of an arrow function", "export default () => 1;\n"],
    ["an import beside code", 'import "./side-effect";\nexport default [1];\n'],
  ])("finds code in %s", (_name, source) => {
    expect(hasExecutableCode("app/file.ts", source)).toBe(true);
  });

  it.each([
    ["a default import", 'import Foo from "./foo";\nexport default Foo;\n'],
    ["a namespace import", 'import * as ns from "./ns";\nexport default ns;\n'],
    ["a named import under another name", 'import { a as b } from "./a";\nexport default b;\n'],
  ])("takes `export default` of %s for a re-export", (_name, source) => {
    expect(hasExecutableCode("app/file.ts", source)).toBe(false);
  });

  it("takes `export default` of a name that was not imported for code", () => {
    expect(
      hasExecutableCode("app/file.ts", 'import Foo from "./foo";\nexport default other;\n'),
    ).toBe(true);
  });
});

describe("findBlindSpots", () => {
  it("names a file that has code and no counted statement", () => {
    const file = "/repo/app/routes.ts";

    expect(
      findBlindSpots(coverageOf(new Map([[file, 0]])), sourcesOf(new Map([[file, ROUTES]]))),
    ).toEqual([file]);
  });

  it("passes a barrel and a type-only file, which list no statements", () => {
    const barrel = "/repo/app/index.ts";
    const types = "/repo/app/types.ts";

    expect(
      findBlindSpots(
        coverageOf(
          new Map([
            [barrel, 0],
            [types, 0],
          ]),
        ),
        sourcesOf(
          new Map([
            [barrel, 'export { a } from "./a";\nexport * from "./b";\n'],
            [types, "export interface Shape {\n  readonly side: number;\n}\n"],
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("passes a file whose statements are counted, without reading it", () => {
    const file = "/repo/app/measured.ts";
    const read = vi.fn(sourcesOf(new Map([[file, ROUTES]])));

    expect(findBlindSpots(coverageOf(new Map([[file, 4]])), read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("lists the blind spots in name order", () => {
    const sources = new Map([
      ["/repo/app/b.ts", ROUTES],
      ["/repo/app/a.ts", ROUTES],
    ]);

    expect(
      findBlindSpots(
        coverageOf(
          new Map([
            ["/repo/app/b.ts", 0],
            ["/repo/app/a.ts", 0],
          ]),
        ),
        sourcesOf(sources),
      ),
    ).toEqual(["/repo/app/a.ts", "/repo/app/b.ts"]);
  });
});

describe("describeBlindSpots", () => {
  it("names each file from the project root, and says what to do about it", () => {
    expect(
      describeBlindSpots(
        ["/repo/frontend/app/routes.ts", "/repo/frontend/app/other.ts"],
        "/repo/frontend",
      ),
    ).toBe(
      [
        "ERROR: The coverage data lists no statements for a file that has code (RT-F3):",
        "  app/routes.ts",
        "  app/other.ts",
        "Vitest's v8 provider does not count `export default <expression>`, so code that is only that is",
        "never measured, whether or not a test loads it. Write `const name = <expression>;` and then",
        "`export default name;`: the constant is a statement of its own.",
      ].join("\n"),
    );
  });
});

describe("isCoverageData", () => {
  const rejected: readonly (readonly [string, unknown])[] = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object without files", { fileCoverageFor: () => undefined }],
    ["an object whose files is not a function", { files: [], fileCoverageFor: () => undefined }],
    ["an object without fileCoverageFor", { files: () => [] }],
    ["an object whose fileCoverageFor is not a function", { files: () => [], fileCoverageFor: 1 }],
  ];

  it.each(rejected)("rejects %s", (_name, value) => {
    expect(isCoverageData(value)).toBe(false);
  });

  it("accepts an object that lists files and answers for each of them", () => {
    expect(isCoverageData({ files: () => [], fileCoverageFor: () => undefined })).toBe(true);
  });
});

describe("BlindSpotReporter", () => {
  const exitCode = process.exitCode;
  const folders: string[] = [];

  afterEach(() => {
    process.exitCode = exitCode;
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** A project folder with these files in it, and a reporter that was given it as its root. */
  function project(files: Readonly<Record<string, string>>) {
    const root = mkdtempSync(join(tmpdir(), "blind-spots-"));
    folders.push(root);
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(join(root, "app"), { recursive: true });
      writeFileSync(join(root, name), source);
    }
    const error = vi.fn<(message: string) => void>();
    const host: ReporterHost = { config: { root }, logger: { error } };
    const reporter = new BlindSpotReporter();
    reporter.onInit(host);
    return { root, error, reporter };
  }

  it("fails the run, naming the file, when a file has code and no statements", () => {
    const { root, error, reporter } = project({ "app/routes.ts": ROUTES });
    const file = join(root, "app", "routes.ts");

    reporter.onCoverage(coverageOf(new Map([[file, 0]])));

    expect(error).toHaveBeenCalledExactlyOnceWith(describeBlindSpots([file], root));
    expect(process.exitCode).toBe(1);
  });

  it("leaves the run alone when every file with code has statements", () => {
    const { root, error, reporter } = project({
      "app/routes.ts": ROUTES,
      "app/index.ts": 'export * from "./routes";\n',
    });

    reporter.onCoverage(
      coverageOf(
        new Map([
          [join(root, "app", "routes.ts"), 1],
          [join(root, "app", "index.ts"), 0],
        ]),
      ),
    );

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  });

  it("fails the run when the coverage data has a shape it does not know", () => {
    const { error, reporter } = project({});

    reporter.onCoverage({ files: [] });

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "ERROR: The coverage data has a shape this check does not know, so it could not look for files with code and no statements.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails the run when a file that is listed cannot be read", () => {
    const { root, error, reporter } = project({});
    const file = join(root, "app", "gone.ts");

    reporter.onCoverage(coverageOf(new Map([[file, 0]])));

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatch(
      /^ERROR: The check for files with code and no statements could not run: Error: ENOENT/u,
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails the run when the coverage data throws something that is not an error", () => {
    const { error, reporter } = project({});

    reporter.onCoverage({
      files: () => {
        const thrown: unknown = "boom";
        throw thrown;
      },
      fileCoverageFor: () => undefined,
    });

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "ERROR: The check for files with code and no statements could not run: boom",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("the Vitest config", () => {
  it("runs the check as a reporter, beside Vitest's own", () => {
    expect(config.test?.reporters).toContain("./scripts/coverage-gate/blind-spots.ts");
    expect(new BlindSpotReporter()).toHaveProperty("onCoverage", expect.any(Function));
  });
});
