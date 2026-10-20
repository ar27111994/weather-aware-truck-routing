import { describe, expect, it } from "vitest";

import { runTokens } from "./cli.ts";
import type { OutputName, TokenIo } from "./cli.ts";
import { generateTokenFiles } from "./generate.ts";

const SOURCE = {
  $description: "ignored metadata",
  primitive: {
    color: {
      ink: {
        $type: "color",
        $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 1, hex: "#000000" },
      },
    },
  },
};
const GENERATED = generateTokenFiles(SOURCE);

/** An in-memory stand-in for the token directory, remembering what was written and said. */
function fakeIo(committed: Partial<Record<OutputName, string>> = {}): TokenIo & {
  readonly written: Map<OutputName, string>;
  readonly said: string[];
  readonly complained: string[];
} {
  const written = new Map<OutputName, string>();
  const said: string[] = [];
  const complained: string[] = [];
  return {
    written,
    said,
    complained,
    readSource: () => Promise.resolve(JSON.stringify(SOURCE)),
    readOutput: (name) => Promise.resolve(committed[name] ?? ""),
    writeOutput: (name, contents) => {
      written.set(name, contents);
      return Promise.resolve();
    },
    log: (message) => {
      said.push(message);
    },
    error: (message) => {
      complained.push(message);
    },
  };
}

describe("runTokens", () => {
  it("writes tokens.css and tokens.ts, and says how many tokens and variables it made", async () => {
    const io = fakeIo();

    const status = await runTokens([], io);

    expect(status).toBe(0);
    expect(io.written.get("tokens.css")).toBe(GENERATED.css);
    expect(io.written.get("tokens.ts")).toBe(GENERATED.ts);
    expect(io.said).toEqual([
      `tokens: ${String(GENERATED.stats.tokens)} | css variables: ${String(GENERATED.stats.cssVariables)} | dark overrides: ${String(GENERATED.stats.darkOverrides)}`,
    ]);
    expect(io.complained).toEqual([]);
  });

  it("with --check passes, and writes nothing, when the committed files are current", async () => {
    const io = fakeIo({ "tokens.css": GENERATED.css, "tokens.ts": GENERATED.ts });

    const status = await runTokens(["--check"], io);

    expect(status).toBe(0);
    expect(io.written.size).toBe(0);
    expect(io.complained).toEqual([]);
  });

  it.each([
    ["tokens.css", { "tokens.css": "stale", "tokens.ts": GENERATED.ts }],
    ["tokens.ts", { "tokens.css": GENERATED.css, "tokens.ts": "stale" }],
  ] as const)("with --check fails and names %s when it is out of date", async (name, committed) => {
    const io = fakeIo(committed);

    const status = await runTokens(["--check"], io);

    expect(status).toBe(1);
    expect(io.complained).toEqual([
      `${name} is out of date. Run "pnpm tokens" and commit the result.`,
    ]);
    expect(io.written.size).toBe(0);
  });

  it("with --check names every file that is out of date, not only the first", async () => {
    const io = fakeIo();

    const status = await runTokens(["--check"], io);

    expect(status).toBe(1);
    expect(io.complained).toHaveLength(2);
  });

  it("finds --check among other arguments", async () => {
    const io = fakeIo();

    expect(await runTokens(["--verbose", "--check"], io)).toBe(1);
  });
});
