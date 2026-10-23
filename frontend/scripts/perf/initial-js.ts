import { gzipSync } from "node:zlib";

/**
 * N1 (REQUIREMENTS.md): the JavaScript a first visit downloads is at most 180 kB gzipped, decimal,
 * as the requirement is written: 180,000 bytes.
 */
export const INITIAL_JS_BUDGET_BYTES = 180_000;

/**
 * D-46 3.5(c), as D-48 sets it: the planner's code is a separate download that starts at the
 * visitor's first input. What a visit downloads once it has given the page one input (the first
 * visit plus what the input loads, no plan asked for) is capped at what the same page downloaded
 * as one eager download on the same base: 338,438 gzipped bytes.
 *
 * That is the build of aeb1abb (the last commit before the D-46 gate; its `git patch-id` equals
 * 78da079's) on the base 710c0dc, measured with `measureInitialJs` in chromium, gzip level 6, one
 * input aimed at the panel, three identical runs. The cap before D-48 was 336,005: the same
 * measurement on the base before 710c0dc, which the base itself moved by 2,433.
 */
export const INPUT_JS_BUDGET_BYTES = 338_438;

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
