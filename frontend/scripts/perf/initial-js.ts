import { gzipSync } from "node:zlib";

/**
 * N1 (REQUIREMENTS.md): the JavaScript a first visit downloads is at most 180 kB gzipped, decimal,
 * as the requirement is written: 180,000 bytes.
 */
export const INITIAL_JS_BUDGET_BYTES = 180_000;

/**
 * D-46 3.5(c), as D-49 words it: the planner's code is a separate download that starts at the
 * visitor's first input. On the same base the split may add only (a) the bytes of the mechanism
 * that D-46 3.1, 3.2, 3.3 and D-47 require and (b) the bytes of fixes for defects the split itself
 * causes; every byte is itemized and the items add up to the delta. This is the most a visit
 * downloads once it has given the page one input (the first visit plus what the input loads, no
 * plan asked for): 343,169 gzipped bytes, which is exactly what the head measures.
 *
 * Where the number comes from (D-48, D-49):
 * - The baseline is `aeb1abb`, the last commit before the D-46 gate (its `git patch-id` equals
 *   `78da079`'s), built as one eager download on the base `710c0dc`: 338,438 bytes.
 * - The split adds 4,731 bytes. 4,688 are its own mechanism (the gate, the handoff of early input,
 *   the island, the router bridge) and the chunk structure a second React root causes. 43 are the
 *   scroll fix of 5beb1eb (`PlannerPanel` shows a plan from its top); the baseline has that defect
 *   too, so those bytes are not the split's and have a row of their own. The rows are in
 *   `.planning/evidence/t7b/d48/itemization.md` and in the pull request.
 * - The method is `measureInitialJs` in chromium, gzip level 6, one input aimed at the planner's
 *   panel (`#planner`).
 *
 * The cap is a ratchet. It never rises, and a change that lowers the total lowers the cap to the
 * new measurement in the same change: `capProblem` fails the check when the total is under the cap
 * as well as when it is over, and a unit test holds the ceiling D-49 set. Nobody meets the cap by
 * moving code behind a later input, an idle callback or a timer unless that is a card of its own
 * with its own input-to-interactive measurement (D-49 item 5).
 */
export const INPUT_JS_BUDGET_BYTES = 343_169;

/**
 * How long after the load event a request still belongs to the first visit. A chunk the page
 * imports lazily but asks for inside this window is downloaded by every visitor, so it counts (D-45).
 */
export const SETTLE_MS = 2_000;

/** zlib's default level, which is what a server that compresses on the fly uses. */
const GZIP_LEVEL = 6;

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
    rawBytes: sum(counted, "rawBytes"),
    gzipBytes: sum(counted, "gzipBytes"),
    excludedGzipBytes: sum(
      files.filter((file) => file.excluded),
      "gzipBytes",
    ),
  };
}

const NUMBER = new Intl.NumberFormat("en-US");

function bytes(count: number): string {
  return `${NUMBER.format(count)} B`;
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
  return `${label} downloads ${bytes(measured.gzipBytes)} of gzipped JavaScript (budget ${bytes(budget)}, ${margin}).`;
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
 * @param total - The gzipped bytes the page downloaded.
 * @param cap - The cap the check holds. Defaults to the planner's cap after one input.
 * @returns What is wrong, or `null` when the cap is exactly the total.
 */
export function capProblem(total: number, cap: number = INPUT_JS_BUDGET_BYTES): string | null {
  if (total > cap) {
    return `The total is ${bytes(total - cap)} over the cap. The cap never rises: take the bytes out, or get a ruling (D-49).`;
  }
  if (total < cap) {
    return `The total is ${bytes(cap - total)} under the cap: lower INPUT_JS_BUDGET_BYTES to ${NUMBER.format(total)} in this change (D-49).`;
  }
  return null;
}
