import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Every test file that listens on an MSW server must call `requireClosedConnections` for it
 * (mswjs/interceptors#862, see `test/close-connections.ts`). A server that starts without the guard
 * lets a request on a reused socket escape to the real network, and the test that sent it fails at
 * random. This test reads the sources, so a new file cannot start a server without the guard.
 *
 * A server starts to intercept requests when something calls `.listen(...)` on it: `setupServer` and
 * `createMockServer` only build one. The files are parsed, so that a word in a comment or in a
 * string cannot stand in for a call, and the fixtures below cannot make this file look like a server.
 *
 * Delete this file together with `test/close-connections.ts`, when #862 is closed.
 */

/** A source file: its path from `frontend/`, with `/`, and its text. */
interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** What the scan found in one file. */
interface Scan {
  readonly path: string;
  /** The file calls `.listen(...)` on something: an MSW server starts to intercept requests. */
  readonly listens: boolean;
  /** The file calls `requireClosedConnections(...)`. Read for a file that listens only. */
  readonly guarded: boolean;
}

/** Every call in the file: `server.listen()` is one; the same words in a comment or a string are not. */
function callsIn({ path, text }: SourceFile): readonly ts.CallExpression[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind));
  return calls;
}

function scan(file: SourceFile): Scan {
  // Parsing is the cost, and a file that does not even say "listen" cannot call it.
  if (!file.text.includes("listen")) {
    return { path: file.path, listens: false, guarded: false };
  }
  const calls = callsIn(file);
  return {
    path: file.path,
    listens: calls.some(
      ({ expression }) =>
        ts.isPropertyAccessExpression(expression) && expression.name.text === "listen",
    ),
    guarded: calls.some(
      ({ expression }) =>
        ts.isIdentifier(expression) && expression.text === "requireClosedConnections",
    ),
  };
}

/** The one file that may listen without the guard: it tests the guard and keeps its socket alive on purpose. */
const KEEPS_SOCKET_ALIVE_ON_PURPOSE = "app/api/mocks/close-connections.test.ts";

/**
 * The test files that take every listener off a mock server's emitter (R5-02):
 * `server.events.removeAllListeners()` takes off the watcher that `requireClosedConnections`
 * registered on the same emitter, and for the rest of the file the guard checks nothing. A test
 * takes off its own listener (`server.events.removeListener(name, listener)`). The emitter of a
 * server is read as `.events`; a copy of it under another name is not seen.
 */
function clearingFiles(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ path, text }) => /\.test\.tsx?$/u.test(path) && text.includes("removeAllListeners"))
    .filter((file) =>
      callsIn(file).some(
        ({ expression }) =>
          ts.isPropertyAccessExpression(expression) &&
          expression.name.text === "removeAllListeners" &&
          ts.isPropertyAccessExpression(expression.expression) &&
          expression.expression.name.text === "events",
      ),
    )
    .map(({ path }) => path)
    .toSorted();
}

/** The files that start a server, by path. */
function serverFiles(files: readonly SourceFile[]): string[] {
  return files
    .map(scan)
    .filter(({ listens }) => listens)
    .map(({ path }) => path)
    .toSorted();
}

/** The files that start a server and do not call the guard, but for the one that may not. */
function unguardedServerFiles(files: readonly SourceFile[]): string[] {
  return files
    .map(scan)
    .filter(
      ({ path, listens, guarded }) => listens && !guarded && path !== KEEPS_SOCKET_ALIVE_ON_PURPOSE,
    )
    .map(({ path }) => path)
    .toSorted();
}

/** What the failure says about such a file. */
function problem(path: string): string {
  return [
    `${path} starts an MSW server without requireClosedConnections(server).`,
    "A request on a reused socket can escape to the real network and fail a test at random",
    "(mswjs/interceptors#862, see test/close-connections.ts).",
    "Start the server with startMockApi() from test/api.tsx.",
  ].join(" ");
}

/** Where `app/` and `test/` are: `frontend/`, three folders up from here. */
const FRONTEND = join(import.meta.dirname, "..", "..", "..");

/** Every `.ts` and `.tsx` file of `app/` and `test/`, never `node_modules`. */
function readTree(): SourceFile[] {
  return ["app", "test"].flatMap((root) =>
    readdirSync(join(FRONTEND, root), { recursive: true, encoding: "utf8" })
      .map((entry) => `${root}/${entry.replaceAll("\\", "/")}`)
      .filter((path) => /\.tsx?$/.test(path) && !path.includes("node_modules"))
      .map((path) => ({ path, text: readFileSync(join(FRONTEND, path), "utf8") })),
  );
}

const LISTENS = "const server = setupServer();\nserver.listen();\n";
const GUARDED = `requireClosedConnections(server);\n${LISTENS}`;

describe("the scan for MSW servers that start without the guard", () => {
  it("flags a file that listens without requireClosedConnections, and says what to do", () => {
    const files = [{ path: "test/new-server.test.ts", text: LISTENS }];

    expect(unguardedServerFiles(files)).toEqual(["test/new-server.test.ts"]);
    const message = problem("test/new-server.test.ts");
    expect(message).toContain("test/new-server.test.ts");
    expect(message).toContain("mswjs/interceptors#862");
    expect(message).toContain("Start the server with startMockApi() from test/api.tsx.");
  });

  it("accepts a file that listens and calls requireClosedConnections", () => {
    const files = [{ path: "test/new-server.test.ts", text: GUARDED }];

    expect(serverFiles(files)).toEqual(["test/new-server.test.ts"]);
    expect(unguardedServerFiles(files)).toEqual([]);
  });

  it("leaves a file alone that builds a server and never listens", () => {
    const files = [{ path: "test/factory.ts", text: "export const make = () => setupServer();\n" }];

    expect(serverFiles(files)).toEqual([]);
  });

  it("does not take a comment or a string for the call", () => {
    const files = [
      { path: "test/comment.test.ts", text: `// requireClosedConnections(server)\n${LISTENS}` },
      {
        path: "test/string.test.ts",
        text: `const note = "requireClosedConnections(server)";\n${LISTENS}`,
      },
    ];

    expect(unguardedServerFiles(files)).toEqual(["test/comment.test.ts", "test/string.test.ts"]);
  });

  it("does not take a comment or a string for a server", () => {
    const files = [
      { path: "test/talk.test.ts", text: '// server.listen()\nconst note = "server.listen()";\n' },
    ];

    expect(serverFiles(files)).toEqual([]);
  });

  it("reads a .tsx file", () => {
    const files = [{ path: "test/view.test.tsx", text: `const view = <p />;\n${LISTENS}` }];

    expect(unguardedServerFiles(files)).toEqual(["test/view.test.tsx"]);
  });

  it("excuses the one file that keeps its socket alive on purpose, and no other", () => {
    const excused = { path: KEEPS_SOCKET_ALIVE_ON_PURPOSE, text: LISTENS };
    const other = { path: "app/api/mocks/other.test.ts", text: LISTENS };

    expect(unguardedServerFiles([excused])).toEqual([]);
    expect(unguardedServerFiles([excused, other])).toEqual(["app/api/mocks/other.test.ts"]);
  });
});

describe("the scan for tests that take every listener off a mock server", () => {
  const planted = (text: string, path = "test/clearing.test.ts"): string[] =>
    clearingFiles([{ path, text }]);

  it("flags a test that calls removeAllListeners on the emitter of a server", () => {
    expect(planted("api.server.events.removeAllListeners();\n")).toEqual(["test/clearing.test.ts"]);
  });

  it("flags it with an event name too, and in a .tsx test", () => {
    const text = 'server.events.removeAllListeners("request:start");\n';
    expect(planted(text)).toEqual(["test/clearing.test.ts"]);
    expect(planted(text, "app/view.test.tsx")).toEqual(["app/view.test.tsx"]);
  });

  it("accepts a test that takes off its own listener", () => {
    expect(planted('api.server.events.removeListener("request:start", onStart);\n')).toEqual([]);
  });

  it("does not take a comment or a string for the call", () => {
    const text =
      "// server.events.removeAllListeners();\nconst note = 'server.events.removeAllListeners()';\n";
    expect(planted(text)).toEqual([]);
  });

  it("leaves alone a helper that is not a test file", () => {
    expect(planted("server.events.removeAllListeners();\n", "test/helper.ts")).toEqual([]);
  });
});

describe("the MSW servers of this repository", () => {
  // The first read of a tree this size is slow on a cold disk: a hook has the longer time-out.
  let tree: SourceFile[] = [];
  beforeAll(() => {
    tree = readTree();
  });

  it("are the five files that listen, so that the scan is not looking at nothing", () => {
    expect(serverFiles(tree)).toEqual([
      "app/api/mocks/close-connections.test.ts",
      "app/api/mocks/handlers-failure.test.ts",
      "app/api/mocks/handlers.test.ts",
      "app/api/queries.test.tsx",
      "test/api.tsx",
    ]);
  });

  it("all call requireClosedConnections, but the one that tests the guard", () => {
    expect(unguardedServerFiles(tree).map(problem)).toEqual([]);
  });

  it("have no test that takes every listener off the emitter, and so the guard with it", () => {
    expect(clearingFiles(tree)).toEqual([]);
  });
});
