// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import {
  findExecutable,
  main,
  parseArguments,
  toFrontendPath,
  type Dependencies,
} from "./in-frontend.ts";

const FRONTEND_DIRECTORY = resolve(import.meta.dirname, "../..");
const ENTRY = resolve(import.meta.dirname, "run-in-frontend.ts");

describe("parseArguments", () => {
  it("splits the tool, its arguments and the files at the separator", () => {
    expect(
      parseArguments([
        "prettier",
        "--write",
        "--ignore-unknown",
        "--",
        "frontend/a.ts",
        "frontend/b.tsx",
      ]),
    ).toEqual({
      tool: "prettier",
      toolArguments: ["--write", "--ignore-unknown"],
      files: ["frontend/a.ts", "frontend/b.tsx"],
    });
  });

  it("takes no tool arguments when none stand before the separator", () => {
    expect(parseArguments(["eslint", "--", "frontend/a.ts"])).toEqual({
      tool: "eslint",
      toolArguments: [],
      files: ["frontend/a.ts"],
    });
  });

  it("keeps a file name with spaces and quotes as one file", () => {
    expect(parseArguments(["eslint", "--", 'frontend/a b\'s "c".ts']).files).toEqual([
      'frontend/a b\'s "c".ts',
    ]);
  });

  it("accepts a separator with no file after it", () => {
    expect(parseArguments(["eslint", "--"]).files).toEqual([]);
  });

  it.each([
    ["no arguments", []],
    ["no separator", ["prettier", "frontend/a.ts"]],
    ["a separator and no tool", ["--", "frontend/a.ts"]],
  ])("refuses %s and says how it is used", (_name, argv) => {
    expect(() => parseArguments(argv)).toThrow(
      "usage: run-in-frontend.ts <tool> [tool arguments] -- <file>...",
    );
  });
});

describe("toFrontendPath", () => {
  it.each([
    ["frontend/app/routes.ts", "app/routes.ts"],
    ["frontend/package.json", "package.json"],
    ['frontend/app/a b\'s "c".tsx', 'app/a b\'s "c".tsx'],
  ])("turns %s into %s", (file, expected) => {
    expect(toFrontendPath(file)).toBe(expected);
  });

  it.each(["backend/src/x.py", "frontend-extra/x.ts", "app/routes.ts", "frontend/"])(
    "refuses %s: it is not a file under frontend/",
    (file) => {
      expect(() => toFrontendPath(file)).toThrow(`not a file under frontend/: ${file}`);
    },
  );
});

describe("findExecutable", () => {
  let directory = "";

  /** Installs a package in the stand-in frontend directory; `manifest` is its package.json. */
  function install(name: string, manifest: Record<string, unknown>): void {
    const packageDirectory = join(directory, "node_modules", name);
    mkdirSync(join(packageDirectory, "bin"), { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name, ...manifest }));
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "in-frontend-"));
    install("string-bin", { bin: "./bin/run.js" });
    install("object-bin", { bin: { "object-bin": "./bin/main.js", other: "./bin/other.js" } });
    install("other-name-only", { bin: { somebody: "./bin/x.js" } });
    install("no-bin", {});
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns the path of a package whose bin is a string", () => {
    expect(findExecutable("string-bin", directory)).toBe(
      join(directory, "node_modules", "string-bin", "bin", "run.js"),
    );
  });

  it("returns the bin that carries the tool's own name", () => {
    expect(findExecutable("object-bin", directory)).toBe(
      join(directory, "node_modules", "object-bin", "bin", "main.js"),
    );
  });

  it("refuses a package whose bins have other names", () => {
    expect(() => findExecutable("other-name-only", directory)).toThrow(
      "the package other-name-only declares no executable of that name",
    );
  });

  it("refuses a package with no bin", () => {
    expect(() => findExecutable("no-bin", directory)).toThrow(
      "the package no-bin declares no executable of that name",
    );
  });

  it("fails for a package that is not installed", () => {
    expect(() => findExecutable("not-installed", directory)).toThrow(/not-installed/);
  });

  it("finds the prettier and the eslint that this project installs", () => {
    expect(findExecutable("prettier", FRONTEND_DIRECTORY)).toMatch(
      /prettier[\\/]bin[\\/]prettier\.cjs$/,
    );
    expect(findExecutable("eslint", FRONTEND_DIRECTORY)).toMatch(/eslint[\\/]bin[\\/]eslint\.js$/);
  });
});

describe("main", () => {
  const frontendDirectory = FRONTEND_DIRECTORY;

  /** Records what it is asked to run and answers with `outcome`. */
  function fakes(outcome: { status: number | null; error?: Error }): {
    spawn: Mock<Dependencies["spawn"]>;
    report: Mock<Dependencies["report"]>;
  } {
    return {
      spawn: vi.fn<Dependencies["spawn"]>(() => outcome),
      report: vi.fn<Dependencies["report"]>(),
    };
  }

  it("starts the tool's own executable in frontend/ with each file as one argument", () => {
    const dependencies = fakes({ status: 0 });
    const code = main(
      [
        "prettier",
        "--write",
        "--ignore-unknown",
        "--",
        "frontend/app/a b.tsx",
        "frontend/package.json",
      ],
      frontendDirectory,
      dependencies,
    );
    expect(code).toBe(0);
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(dependencies.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        findExecutable("prettier", frontendDirectory),
        "--write",
        "--ignore-unknown",
        "app/a b.tsx",
        "package.json",
      ],
      { cwd: frontendDirectory, stdio: "inherit" },
    );
    expect(dependencies.report).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("returns the exit status of the tool (%i)", (status) => {
    expect(main(["eslint", "--", "frontend/a.ts"], frontendDirectory, fakes({ status }))).toBe(
      status,
    );
  });

  it("returns 1 when a signal ended the tool", () => {
    expect(
      main(["eslint", "--", "frontend/a.ts"], frontendDirectory, fakes({ status: null })),
    ).toBe(1);
  });

  it("says why and returns 1 when the tool cannot be started", () => {
    const dependencies = fakes({ status: null, error: new Error("spawn ENOENT") });
    expect(main(["eslint", "--", "frontend/a.ts"], frontendDirectory, dependencies)).toBe(1);
    expect(dependencies.report).toHaveBeenCalledWith("Error: spawn ENOENT");
  });

  it("refuses a file outside frontend/, says so and runs nothing", () => {
    const dependencies = fakes({ status: 0 });
    expect(
      main(["eslint", "--", "frontend/a.ts", "backend/x.py"], frontendDirectory, dependencies),
    ).toBe(1);
    expect(dependencies.report).toHaveBeenCalledWith(
      "Error: not a file under frontend/: backend/x.py",
    );
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });

  it("says that a tool is not installed and returns 1", () => {
    const dependencies = fakes({ status: 0 });
    expect(main(["no-such-tool", "--", "frontend/a.ts"], frontendDirectory, dependencies)).toBe(1);
    expect(dependencies.report).toHaveBeenCalledWith(expect.stringContaining("no-such-tool"));
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });

  it("says how it is used and returns 1 for arguments it does not understand", () => {
    const dependencies = fakes({ status: 0 });
    expect(main(["eslint"], frontendDirectory, dependencies)).toBe(1);
    expect(dependencies.report).toHaveBeenCalledWith(
      expect.stringContaining("usage: run-in-frontend.ts"),
    );
  });

  it("runs nothing and succeeds when no file is given", () => {
    const dependencies = fakes({ status: 1 });
    expect(main(["eslint", "--"], frontendDirectory, dependencies)).toBe(0);
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });
});

describe("the entry, in this process", () => {
  it("hands the command line to main and sets the exit code", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? "node", ENTRY, "no-such-tool", "--", "frontend/a.ts"];
    try {
      await import("./run-in-frontend.ts");
      expect(process.exitCode).toBe(1);
      expect(report).toHaveBeenCalledWith(expect.stringContaining("no-such-tool"));
    } finally {
      process.argv = originalArgv;
      process.exitCode = undefined;
    }
  });
});

describe("the entry, as the hook runs it (real processes, the real prettier)", () => {
  /** A directory under frontend/ so that `frontend/<it>/<file>` is a real path, as pre-commit names it. */
  let fixtureDirectory = "";
  let fixturePath = "";

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(FRONTEND_DIRECTORY, "scripts", "precommit", "fixture-"));
    fixturePath = relative(FRONTEND_DIRECTORY, fixtureDirectory).replaceAll("\\", "/");
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  /** Starts the entry from the repository root, as pre-commit does. */
  function run(...argv: string[]): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [ENTRY, ...argv], {
      cwd: join(FRONTEND_DIRECTORY, ".."),
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it("passes a formatted file whose name has a space", () => {
    writeFileSync(join(fixtureDirectory, "formatted name.ts"), "export const value = 1;\n");
    const { status, output } = run(
      "prettier",
      "--check",
      "--ignore-unknown",
      "--",
      `frontend/${fixturePath}/formatted name.ts`,
    );
    expect(output).toContain("All matched files use Prettier code style!");
    expect(status).toBe(0);
  });

  it("fails an unformatted file whose name has a space and names it from frontend/", () => {
    writeFileSync(join(fixtureDirectory, "unformatted name.ts"), "export const   value=1\n");
    const { status, output } = run(
      "prettier",
      "--check",
      "--ignore-unknown",
      "--",
      `frontend/${fixturePath}/unformatted name.ts`,
    );
    expect(output).toContain(`${fixturePath}/unformatted name.ts`);
    expect(output).not.toContain(`frontend/${fixturePath}`);
    expect(status).toBe(1);
  });

  it("leaves a file type that prettier does not know alone when asked to ignore it", () => {
    writeFileSync(join(fixtureDirectory, "unknown type.xyz"), "anything\n");
    const { status } = run(
      "prettier",
      "--check",
      "--ignore-unknown",
      "--",
      `frontend/${fixturePath}/unknown type.xyz`,
    );
    expect(status).toBe(0);
  });

  it("exits 1 and says why when the tool is not installed", () => {
    const { status, output } = run("no-such-tool", "--", "frontend/a.ts");
    expect(output).toContain("no-such-tool");
    expect(status).toBe(1);
  });
});
