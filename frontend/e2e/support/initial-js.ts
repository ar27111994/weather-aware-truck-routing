import type { Page, Response } from "@playwright/test";

import { SETTLE_MS, measureScript, summarise } from "../../scripts/perf/initial-js.ts";
import type { InitialJs, ScriptFile } from "../../scripts/perf/initial-js.ts";

/** A JavaScript file: a script request, or any `.js` / `.mjs` path (an import, a worker). */
function isScript(response: Response): boolean {
  return (
    response.request().resourceType() === "script" ||
    /\.m?js$/u.test(new URL(response.url()).pathname)
  );
}

/**
 * What a first visit to `path` downloads in JavaScript (N1, D-45): every script file the browser
 * requests from the start of the navigation until `SETTLE_MS` after the load event, with no input
 * from the visitor. A chunk the page imports lazily counts when it is requested inside that window.
 * Each file is counted once, however often the page asks for it.
 *
 * @param page - A fresh page: its context has no cache, so every file is downloaded.
 * @param path - The path to open, for example `/methodology`.
 * @param afterLoad - What the visitor does once the page has loaded (an input, say), before the
 *   window closes. Leave it out to measure a visit with no input.
 */
export async function measureInitialJs(
  page: Page,
  path: string,
  afterLoad?: (page: Page) => Promise<void>,
): Promise<InitialJs> {
  const context = page.context();
  const responses = new Map<string, Response>();
  const collect = (response: Response): void => {
    if (response.ok() && isScript(response)) responses.set(response.url(), response);
  };

  context.on("response", collect);
  await page.goto(path, { waitUntil: "load" });
  await afterLoad?.(page);
  await page.waitForTimeout(SETTLE_MS);
  context.off("response", collect);

  const files: ScriptFile[] = [];
  for (const response of responses.values()) {
    files.push(measureScript(new URL(response.url()).pathname, await response.body()));
  }
  return summarise(files);
}
