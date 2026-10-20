import { generateTokenFiles } from "./generate.ts";

/** The two files `pnpm tokens` writes next to `tokens.json`. */
export type OutputName = "tokens.css" | "tokens.ts";

/** Everything the CLI touches outside itself, so a test can give it a fake. */
export interface TokenIo {
  /** The text of `tokens.json`. */
  readonly readSource: () => Promise<string>;
  /** The text of a generated file as committed. */
  readonly readOutput: (name: OutputName) => Promise<string>;
  readonly writeOutput: (name: OutputName, contents: string) => Promise<void>;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/**
 * `pnpm tokens` regenerates `tokens.css` and `tokens.ts` from `tokens.json`; `pnpm tokens:check`
 * (`--check`) writes nothing and fails when a committed generated file differs from a fresh run.
 * The process wrapper `scripts/build-tokens.ts` only connects this to the file system and the
 * console, so every rule is here, under test.
 *
 * @param args - The command line after the script name.
 * @param io - The files and the console.
 * @returns The exit status: 0, or 1 when `--check` finds a file out of date.
 */
export async function runTokens(args: readonly string[], io: TokenIo): Promise<number> {
  const source: unknown = JSON.parse(await io.readSource());
  const { css, ts, stats } = generateTokenFiles(source);
  const outputs: readonly { readonly name: OutputName; readonly contents: string }[] = [
    { name: "tokens.css", contents: css },
    { name: "tokens.ts", contents: ts },
  ];

  if (args.includes("--check")) {
    let drifted = false;
    for (const { name, contents } of outputs) {
      if ((await io.readOutput(name)) !== contents) {
        io.error(`${name} is out of date. Run "pnpm tokens" and commit the result.`);
        drifted = true;
      }
    }
    return drifted ? 1 : 0;
  }

  for (const { name, contents } of outputs) {
    await io.writeOutput(name, contents);
  }
  io.log(
    `tokens: ${String(stats.tokens)} | css variables: ${String(stats.cssVariables)} | dark overrides: ${String(stats.darkOverrides)}`,
  );
  return 0;
}
