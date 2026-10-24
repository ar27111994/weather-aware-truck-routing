import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * N1 (REQUIREMENTS.md): the JavaScript a first visit downloads is at most 180 kB gzipped, decimal,
 * as the requirement is written: 180,000 bytes.
 */
export const INITIAL_JS_BUDGET_BYTES = 180_000;

/**
 * D-46 3.5(c), as D-49 words it: the planner's code is a separate download that starts at the
 * visitor's first input. On the same base the split may add only (a) the bytes of the mechanism
 * that D-46 3.1, 3.2, 3.3 and D-47 require, (b) the bytes of fixes for defects the split itself
 * causes and (c) the bytes of fixes for defects that existed before the split and that a review
 * finding names (D-51); every byte is itemized and the items add up to the delta. This is the most a visit
 * downloads once it has given the page one input (the first visit plus what the input loads, no
 * plan asked for): 332,625 gzipped bytes, which is exactly what the head measures.
 *
 * Where the number comes from (D-48, D-49):
 * - The baseline is `aeb1abb`, the last commit before the D-46 gate (its `git patch-id` equals
 *   `78da079`'s), built as one eager download on the base `710c0dc`: 338,438 bytes.
 * - The split adds 4,731 bytes. 4,688 are its own mechanism (the gate, the handoff of early input,
 *   the island, the router bridge) and the chunk structure a second React root causes. 43 are the
 *   scroll fix of 5beb1eb (`PlannerPanel` shows a plan from its top); the baseline has that defect
 *   too, so those bytes are not the split's: they are a (c) row, R4-17 (D-51). The rows are in
 *   `.planning/evidence/t7b/d48/itemization.md` and in the pull request. That made 343,169.
 * - The method is `measureInitialJs` in chromium, gzip level 6, one input aimed at the planner's
 *   panel (`#planner`).
 * - P1 (D-48) lowered the cap from 343,169 to 332,625, 10,544 bytes and 33 files less. Nothing moved
 *   behind the input: `demoBlindChunks` (vite.config.ts) stopped the style guide's 40 lazy demos from
 *   cutting the shared code of the first load, which had also cut the shared code that the input
 *   loads (107 files before, 74 after). The cap is the number that CI measures on that head.
 *
 * The cap is a ratchet. It rises only by itemized (b) and (c) rows (D-51): each names its finding id,
 * the bytes CI measured and the chunk diff that shows them, and the independent gate verifies the row.
 * Nothing else raises it: a feature, a refactor, a toolchain or method change and an unattributed
 * byte each need a release-owner ruling first. A change that lowers the total lowers the cap to the
 * new measurement in the same change: `capProblem` fails the check when the total is under the cap
 * as well as when it is over, and a unit test holds the ceiling D-49 set. Nobody meets the cap by
 * moving code behind a later input, an idle callback or a timer unless that is a card of its own
 * with its own input-to-interactive measurement (D-49 item 5).
 */
export const INPUT_JS_BUDGET_BYTES = 332_625;

/**
 * P1 (D-48): how many script files a first visit may request, page by page. D-35 made each of the
 * style guide's 40 demos a lazy entry point, and Rollup cuts the shared code of every page along
 * them: before P1 the first load of `/` was 42 files, 20 more than the same app with the 40 demos
 * behind ONE lazy chunk (and 7.5 kB gzipped more), and every script of a page is a modulepreload
 * that the first paint waits for. These are the numbers of that same app, measured by
 * `measureInitialJs` on `e560de5`: 22 files for `/`, 26 for `/methodology` and 18 for the SPA
 * fallback. A page that asks for more has its shared code cut along the demos again.
 *
 * The bytes have their own budget (`INITIAL_JS_BUDGET_BYTES`), but it cannot see the tax: the room
 * P1 gave back is about as big as the tax was.
 */
export const INITIAL_JS_FILE_BUDGETS = { planner: 22, methodology: 26, fallback: 18 } as const;

/**
 * R3-12: the most gzipped JavaScript the style guide downloads, in the two shapes it is asked for.
 * PROBE: deliberately too small, so that the failing run prints what each page really downloads.
 */
export const DESIGN_JS_BUDGET_BYTES = { section: 1_000, all: 1_000 } as const;

/**
 * How long after the load event a request still belongs to the first visit. A chunk the page
 * imports lazily but asks for inside this window is downloaded by every visitor, so it counts (D-45).
 */
export const SETTLE_MS = 2_000;

/** zlib's default level, which is what a server that compresses on the fly uses. */
const GZIP_LEVEL = 6;

/**
 * The Node release that measures the budgets: the exact version in `frontend/.nvmrc` (Q3, D-51
 * item 5). Every CI job installs it from that file and `engines` in `package.json` repeats it, so
 * the exact numbers above (`INPUT_JS_BUDGET_BYTES`) are measured on one Node. A gzipped length
 * belongs to the zlib build that gzips, and the zlib build inside Node can change from one release
 * to the next, so a run on any other Node cannot judge an exact number (`capProblem`) and CI is the
 * authority.
 *
 * To move the pin, change `.nvmrc` and `engines` together (a unit test holds them equal) and
 * measure again in the same change: a move that lowers a total lowers its cap, and one that raises
 * a total with no change of app code needs a release-owner ruling first (D-51 item 6).
 */
export const MEASURED_ON_NODE = readFileSync(
  join(import.meta.dirname, "..", "..", ".nvmrc"),
  "utf8",
).trim();

/**
 * The one thing the budget leaves out: MapLibre GL with the map view built on it (loaded lazily when
 * a map is drawn) and the worker script MapLibre starts. The pattern names the two chunks exactly,
 * so no other chunk can slip out of the measurement by accident.
 */
const MAPLIBRE_CHUNK = /\/assets\/(?:MapView|maplibre-gl-worker)-[\w-]+\.m?js$/u;

/** A script file the page downloaded, with the sizes that matter. */
export interface ScriptFile {
  /** The URL path, such as `/assets/home-bjkro1fK.js`. */
  readonly path: string;
  /** Bytes as served. */
  readonly rawBytes: number;
  /** Bytes after gzip. */
  readonly gzipBytes: number;
  /** True for a MapLibre chunk, which the budget does not count. */
  readonly excluded: boolean;
}

/** What one page downloads. */
export interface InitialJs {
  /** Every script, biggest gzip size first. */
  readonly files: readonly ScriptFile[];
  /** How many scripts count: the files, MapLibre excluded. */
  readonly fileCount: number;
  /** Bytes as served, MapLibre excluded. */
  readonly rawBytes: number;
  /** The number the budget applies to: gzipped bytes, MapLibre excluded. */
  readonly gzipBytes: number;
  /** Gzipped bytes of the MapLibre chunks, reported but not counted. */
  readonly excludedGzipBytes: number;
}

/**
 * Whether a script is MapLibre's, which the budget leaves out.
 *
 * @param path - The URL path of the script.
 */
export function isMapLibreChunk(path: string): boolean {
  return MAPLIBRE_CHUNK.test(path);
}

/**
 * Sizes one downloaded script.
 *
 * @param path - The URL path of the script.
 * @param body - The bytes the server sent.
 */
export function measureScript(path: string, body: Uint8Array): ScriptFile {
  return {
    path,
    rawBytes: body.length,
    gzipBytes: gzipSync(body, { level: GZIP_LEVEL }).length,
    excluded: isMapLibreChunk(path),
  };
}

/**
 * Totals the scripts of one page. The MapLibre chunks are listed but never added to the total.
 *
 * @param files - The scripts the page downloaded.
 */
export function summarise(files: readonly ScriptFile[]): InitialJs {
  const counted = files.filter((file) => !file.excluded);
  const sum = (list: readonly ScriptFile[], key: "rawBytes" | "gzipBytes"): number =>
    list.reduce((total, file) => total + file[key], 0);
  return {
    files: [...files].sort((left, right) => right.gzipBytes - left.gzipBytes),
    fileCount: counted.length,
    rawBytes: sum(counted, "rawBytes"),
    gzipBytes: sum(counted, "gzipBytes"),
    excludedGzipBytes: sum(
      files.filter((file) => file.excluded),
      "gzipBytes",
    ),
  };
}

const NUMBER = new Intl.NumberFormat("en-US");

/** A byte count the way the reports write it: `1,234 B`. */
function bytes(count: number): string {
  return `${NUMBER.format(count)} B`;
}

/** `1 file`, `2 files`: a count and its noun. */
function plural(count: number, noun: string): string {
  return `${NUMBER.format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One line: what a page downloads against the budget.
 *
 * @param label - The page, for example `/`.
 * @param measured - What the page downloaded.
 * @param budget - The most gzipped bytes the page may download.
 */
export function summaryLine(
  label: string,
  measured: InitialJs,
  budget: number = INITIAL_JS_BUDGET_BYTES,
): string {
  const margin =
    measured.gzipBytes > budget
      ? `over by ${bytes(measured.gzipBytes - budget)}`
      : `under by ${bytes(budget - measured.gzipBytes)}`;
  const size = `${bytes(measured.gzipBytes)} of gzipped JavaScript in ${plural(measured.fileCount, "file")}`;
  return `${label} downloads ${size} (budget ${bytes(budget)}, ${margin}).`;
}

/**
 * A report for the test output: the summary line, then every script, biggest first.
 *
 * @param label - The page, for example `/`.
 * @param measured - What the page downloaded.
 * @param budget - The most gzipped bytes the page may download.
 */
export function describeInitialJs(
  label: string,
  measured: InitialJs,
  budget: number = INITIAL_JS_BUDGET_BYTES,
): string {
  const lines = [summaryLine(label, measured, budget)];
  for (const file of measured.files) {
    const note = file.excluded ? "  (MapLibre, not counted)" : "";
    lines.push(`  ${bytes(file.gzipBytes).padStart(10)}  ${file.path}${note}`);
  }
  if (measured.excludedGzipBytes > 0) {
    lines.push(`not counted (MapLibre): ${bytes(measured.excludedGzipBytes)}`);
  }
  return lines.join("\n");
}

/**
 * D-49's ratchet for the planner's cap. The cap is the measured total, exactly: a total over it is
 * a regression, and a total under it means the cap went stale and has to come down in the same
 * change, so nobody can spend the room later.
 *
 * Only the pinned Node (`MEASURED_ON_NODE`) can judge an exact number. On any other Node the answer
 * says that it cannot, and it names no number to set the cap to: a number measured on a Node that
 * CI does not run could be wrong (Q3, D-51 item 5).
 *
 * @param total - The gzipped bytes the page downloaded.
 * @param cap - The cap the check holds. Defaults to the planner's cap after one input.
 * @param node - The Node that measured the total, as `process.version` writes it. Defaults to the
 *   Node that runs the check.
 * @returns What is wrong, or `null` when the cap is exactly the total.
 */
export function capProblem(
  total: number,
  cap: number = INPUT_JS_BUDGET_BYTES,
  node: string = process.version,
): string | null {
  if (node !== `v${MEASURED_ON_NODE}`) {
    return (
      `This run cannot judge exact equality on Node ${node}; CI is the authority. The cap is the total ` +
      `that CI measures on Node ${MEASURED_ON_NODE} (frontend/.nvmrc, D-51 item 5): run the check on ` +
      "that Node, or take the number from the CI log. Do not change the cap from this run."
    );
  }
  if (total > cap) {
    return `The total is ${bytes(total - cap)} over the cap. The cap rises only by itemized fixes of defects (D-51: a finding id, the bytes CI measured, the chunk diff): take the bytes out, or itemize them and get a ruling.`;
  }
  if (total < cap) {
    return `The total is ${bytes(cap - total)} under the cap: lower INPUT_JS_BUDGET_BYTES to ${NUMBER.format(total)} in this change (D-49).`;
  }
  return null;
}

/**
 * P1's guard against the D-35 chunk tax: a page may request no more script files than the same
 * app does with the style guide's demos behind one chunk (`INITIAL_JS_FILE_BUDGETS`). The tax
 * shows in the file count before it shows in the bytes.
 *
 * @param label - The page, for example `/`.
 * @param measured - What the page downloaded.
 * @param budget - The most script files the page may request, MapLibre's chunks aside.
 * @returns What is wrong, or `null` when the page is within its budget.
 */
export function fileBudgetProblem(
  label: string,
  measured: InitialJs,
  budget: number,
): string | null {
  if (measured.fileCount <= budget) return null;
  const over = measured.fileCount - budget;
  return (
    `${label} requests ${plural(measured.fileCount, "script file")}, ${NUMBER.format(over)} over the budget of ${NUMBER.format(budget)}. ` +
    "The budget is what the same page requests with the style guide's demos behind one chunk: more files " +
    "mean its shared code is cut along the demos again (P1, D-48). Check `demoBlindChunks` in " +
    "vite.config.ts, then read the list of files in the report."
  );
}
