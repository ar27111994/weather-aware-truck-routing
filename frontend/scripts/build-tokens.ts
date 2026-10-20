/**
 * `pnpm tokens`        regenerate `tokens.css` and `tokens.ts` from `tokens.json`.
 * `pnpm tokens:check`  fail (exit 1) when the committed generated files differ from a fresh run.
 *
 * Process wrapper only: the rules live in `tokens/cli.ts` and `tokens/generate.ts`, which the unit
 * tests cover. Runs on Node's built-in TypeScript support, so there is no extra runner dependency.
 */
import { readFile, writeFile } from "node:fs/promises";

import { runTokens } from "./tokens/cli.ts";

const TOKENS_DIR = new URL("../app/design-system/tokens/", import.meta.url);

process.exitCode = await runTokens(process.argv.slice(2), {
  readSource: () => readFile(new URL("tokens.json", TOKENS_DIR), "utf8"),
  readOutput: (name) => readFile(new URL(name, TOKENS_DIR), "utf8"),
  writeOutput: (name, contents) => writeFile(new URL(name, TOKENS_DIR), contents, "utf8"),
  log: (message) => {
    console.log(message);
  },
  error: (message) => {
    console.error(message);
  },
});
