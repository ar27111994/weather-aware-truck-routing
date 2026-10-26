/**
 * Runs a frontend tool (prettier, eslint) on the files that pre-commit hands to a hook.
 *
 * pre-commit starts a hook at the repository root and names each file from there
 * (`frontend/app/routes.ts`, always with forward slashes), while the tools read their configuration
 * and their ignore files from `frontend/`. This module removes the `frontend/` prefix and starts
 * the tool in `frontend/`, with the Node that runs it and without a shell, so a file name with a space
 * or a quote reaches the tool as one argument.
 *
 * The tool's executable is found through its own package.json, from `frontend/`: the release is the
 * one `pnpm-lock.yaml` pins, the one `pnpm exec` would run, without the start-up time of pnpm.
 *
 * `run-in-frontend.ts` is the process entry; the rules and every branch are here.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** How pre-commit names a frontend file: from the repository root. */
const FRONTEND_PREFIX = "frontend/";

const USAGE = "usage: run-in-frontend.ts <tool> [tool arguments] -- <file>...";

export interface Invocation {
  readonly tool: string;
  readonly toolArguments: readonly string[];
  readonly files: readonly string[];
}

/** What `main` needs from the outside; the tests pass their own. */
export interface Dependencies {
  readonly spawn: (
    command: string,
    args: string[],
    options: { cwd: string; stdio: "inherit" },
  ) => { status: number | null; error?: Error | undefined };
  readonly report: (message: string) => void;
}

const realDependencies: Dependencies = {
  spawn: spawnSync,
  report: (message) => {
    console.error(message);
  },
};

/** Splits `<tool> [tool arguments] -- <file>...`: pre-commit appends the files after the entry's own `--`. */
export function parseArguments(argv: readonly string[]): Invocation {
  const separator = argv.indexOf("--");
  const tool = argv[0];
  if (tool === undefined || separator < 1) {
    throw new Error(USAGE);
  }
  return { tool, toolArguments: argv.slice(1, separator), files: argv.slice(separator + 1) };
}

/** `frontend/app/a b.tsx` becomes `app/a b.tsx`. A file outside `frontend/` is a mistake in the hook's `files:` pattern. */
export function toFrontendPath(file: string): string {
  const relative = file.startsWith(FRONTEND_PREFIX) ? file.slice(FRONTEND_PREFIX.length) : "";
  if (relative === "") {
    throw new Error(`not a file under ${FRONTEND_PREFIX}: ${file}`);
  }
  return relative;
}

interface PackageManifest {
  readonly bin?: string | Readonly<Record<string, string>>;
}

/** The executable that the package `tool` declares for itself, found from `frontendDirectory`. */
export function findExecutable(tool: string, frontendDirectory: string): string {
  const requireFromFrontend = createRequire(path.join(frontendDirectory, "package.json"));
  const manifestPath = requireFromFrontend.resolve(`${tool}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const relative = typeof bin === "string" ? bin : bin?.[tool];
  if (relative === undefined) {
    throw new Error(`the package ${tool} declares no executable of that name`);
  }
  return path.resolve(path.dirname(manifestPath), relative);
}

/**
 * Runs the tool on the files and returns the exit code of the hook: the tool's own, or 1 when the
 * tool could not be run at all (said on stderr, never swallowed).
 */
export function main(
  argv: readonly string[],
  frontendDirectory: string,
  dependencies: Dependencies = realDependencies,
): number {
  try {
    const { tool, toolArguments, files } = parseArguments(argv);
    if (files.length === 0) {
      return 0;
    }
    const executable = findExecutable(tool, frontendDirectory);
    const result = dependencies.spawn(
      process.execPath,
      [executable, ...toolArguments, ...files.map(toFrontendPath)],
      { cwd: frontendDirectory, stdio: "inherit" },
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    // A tool that a signal ended has no status.
    return result.status ?? 1;
  } catch (error) {
    dependencies.report(String(error));
    return 1;
  }
}
