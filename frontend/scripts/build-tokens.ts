/**
 * `pnpm tokens`        regenerate `tokens.css` and `tokens.ts` from `tokens.json`.
 * `pnpm tokens:check`  fail (exit 1) when the committed generated files differ from a fresh run.
 *
 * Thin process wrapper: every rule lives in `tokens/generate.ts`, which the unit tests cover.
 * Runs on Node's built-in TypeScript support, so there is no extra runner dependency.
 */
import { readFile, writeFile } from "node:fs/promises";

import { generateTokenFiles } from "./tokens/generate.ts";

const TOKENS_DIR = new URL("../app/design-system/tokens/", import.meta.url);

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const source: unknown = JSON.parse(await readFile(new URL("tokens.json", TOKENS_DIR), "utf8"));
  const { css, ts, stats } = generateTokenFiles(source);
  const outputs = [
    { name: "tokens.css", contents: css },
    { name: "tokens.ts", contents: ts },
  ];

  if (check) {
    let drifted = false;
    for (const { name, contents } of outputs) {
      const committed = await readFile(new URL(name, TOKENS_DIR), "utf8");
      if (committed !== contents) {
        console.error(`${name} is out of date. Run "pnpm tokens" and commit the result.`);
        drifted = true;
      }
    }
    return drifted ? 1 : 0;
  }

  for (const { name, contents } of outputs) {
    await writeFile(new URL(name, TOKENS_DIR), contents, "utf8");
  }
  console.log(
    `tokens: ${String(stats.tokens)} | css variables: ${String(stats.cssVariables)} | dark overrides: ${String(stats.darkOverrides)}`,
  );
  return 0;
}

process.exitCode = await main();
