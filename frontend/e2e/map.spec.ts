import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * `/design/map` in a real browser: the R7 smoothness budget, visual goldens and axe. The harness
 * draws the fixture trip (Salt Lake City to Denver, severe weather on the fastest route) with all
 * 49 heatmap frames decoded before the slider enables.
 */

type ThemeName = "light" | "dark";

const THEMES: readonly ThemeName[] = ["light", "dark"];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;
/** The map has loaded its style and tiles within this, or the test fails. */
const MAP_READY_MS = 60_000;

/** What the in-page probe collects during a sweep. */
interface Probe {
  frames: number[];
  longTasks: number[];
  running: boolean;
}

declare global {
  interface Window {
    __hcProbe?: Probe;
  }
}

async function openMap(page: Page, theme: ThemeName, query = ""): Promise<void> {
  await page.addInitScript((saved) => {
    window.localStorage.setItem("hc-theme", saved);
  }, theme);
  await page.goto(`/design/map${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Map harness" })).toBeVisible();
  const map = page.getByTestId("map-canvas-container");
  await expect(map).toHaveAttribute("data-style-ready", "true", { timeout: MAP_READY_MS });
  await expect(page.getByRole("slider", { name: "Forecast time" })).toBeVisible();
  await expect(map).toHaveAttribute("data-idle", "true", { timeout: MAP_READY_MS });
  await page.evaluate(() => document.fonts.ready);
}

/** Starts timing every animation frame and every long task on the page. */
async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe: Probe = { frames: [], longTasks: [], running: true };
    window.__hcProbe = probe;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    let last = performance.now();
    const loop = (now: number): void => {
      probe.frames.push(now - last);
      last = now;
      if (probe.running) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function stopProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const probe = window.__hcProbe;
    if (!probe) throw new Error("the probe was not started");
    probe.running = false;
    return probe;
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
}

function summarise(probe: Probe): Record<string, number> {
  // The first delta spans the probe's own start-up, not a frame of the sweep.
  const frames = probe.frames.slice(1);
  return {
    frames: frames.length,
    median_frame_ms: Number(median(frames).toFixed(2)),
    p95_frame_ms: Number(percentile(frames, 0.95).toFixed(2)),
    max_frame_ms: Number(Math.max(...frames).toFixed(2)),
    long_tasks: probe.longTasks.length,
    longest_task_ms: Number(Math.max(0, ...probe.longTasks).toFixed(2)),
  };
}

/** What the harness's live map shows: the evidence that a sweep measures a real workload (D-39). */
interface Workload {
  readonly zoom: number;
  /** The zoom of the fit the harness asked for; `null` when the trip cannot fit the canvas. */
  readonly fitZoom: number | null;
  readonly routeVertices: number;
  readonly routeVerticesOutside: number;
  /** Features in each `hc-*` source, and how many distinct ones its layers drew. */
  readonly sourceFeatures: Record<string, number>;
  readonly renderedFeatures: Record<string, number>;
}

/** Reads {@link Workload} from `window.__hcHarness` (published by `/design/map`). */
async function readWorkload(page: Page): Promise<Workload> {
  return page.evaluate(() => {
    interface Feature {
      readonly id?: string | number;
      readonly properties: Record<string, unknown>;
      readonly geometry: { readonly type: string; readonly coordinates: unknown };
    }
    interface ProbeMap {
      getZoom(): number;
      getCanvas(): HTMLCanvasElement;
      getStyle(): { layers: { id: string; source?: string }[] };
      getSource(id: string): { serialize(): { data: { features: Feature[] } } } | undefined;
      cameraForBounds(bounds: number[][], options: object): { zoom: number } | undefined;
      project(lngLat: [number, number]): { x: number; y: number };
      queryRenderedFeatures(options: { layers: string[] }): Feature[];
    }
    const harness = Reflect.get(window, "__hcHarness") as
      { map: ProbeMap; padding: object } | undefined;
    if (!harness) throw new Error("/design/map published no map");
    const { map, padding } = harness;
    const features = (id: string): Feature[] => map.getSource(id)?.serialize().data.features ?? [];
    const vertices = features("hc-routes").flatMap(
      (feature) => feature.geometry.coordinates as [number, number][],
    );
    const lons = vertices.map(([lon]) => lon);
    const lats = vertices.map(([, lat]) => lat);
    const fit = map.cameraForBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding, maxZoom: 10 },
    );
    const canvas = map.getCanvas();
    const outside = vertices.filter((vertex) => {
      const point = map.project(vertex);
      return (
        point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight
      );
    }).length;
    const sourceFeatures: Record<string, number> = {};
    const renderedFeatures: Record<string, number> = {};
    for (const source of ["hc-routes", "hc-ribbon", "hc-checkpoints", "hc-heatmap"]) {
      const layers = map
        .getStyle()
        .layers.filter((layer) => layer.source === source)
        .map((layer) => layer.id);
      // Ribbon stretches carry no id; their route and index name them.
      const key = (feature: Feature): string =>
        feature.id === undefined ? JSON.stringify(feature.properties) : String(feature.id);
      sourceFeatures[source] = features(source).length;
      renderedFeatures[source] = new Set(map.queryRenderedFeatures({ layers }).map(key)).size;
    }
    return {
      zoom: map.getZoom(),
      fitZoom: fit?.zoom ?? null,
      routeVertices: vertices.length,
      routeVerticesOutside: outside,
      sourceFeatures,
      renderedFeatures,
    };
  });
}

/** Fails unless the trip is framed as asked and every `hc-*` feature drew. */
function expectRealWorkload(workload: Workload): void {
  expect(workload.fitZoom, "the trip fits the canvas").not.toBeNull();
  expect(Math.abs(workload.zoom - (workload.fitZoom ?? Number.NaN))).toBeLessThan(0.05);
  expect(workload.routeVertices).toBeGreaterThan(0);
  expect(workload.routeVerticesOutside, "route vertices outside the canvas").toBe(0);
  for (const [source, count] of Object.entries(workload.sourceFeatures)) {
    expect(count, `${source} has features`).toBeGreaterThan(0);
    expect(workload.renderedFeatures[source], `${source} drew all its features`).toBe(count);
  }
}

/** What one paced keyboard step left behind. */
interface Step {
  readonly expected: number;
  readonly frame: number;
  /** MapLibre `render` events between the key press and the presented frame. */
  readonly renders: number;
  /** The sum of every corridor cell's `feature-state.v` after the step. */
  readonly cell: unknown;
}

/**
 * The keyboard half of a sweep, paced at one step per presented frame (D-39): press a key, then
 * wait two animation frames (the controller applies the step in the first, MapLibre draws it, the
 * second presents it) and read back what the step did.
 */
async function pacedKeyboardSweep(page: Page): Promise<Step[]> {
  await page.evaluate(() => {
    const harness = Reflect.get(window, "__hcHarness") as
      { map: { on(type: string, listener: () => void): void } } | undefined;
    if (!harness) throw new Error("/design/map published no map");
    const counter = { renders: 0 };
    Reflect.set(window, "__hcRenders", counter);
    harness.map.on("render", () => {
      counter.renders += 1;
    });
  });
  const steps: Step[] = [];
  const keys = [
    ...Array.from({ length: 48 }, (_unused, index) => ({ key: "ArrowRight", expected: index + 1 })),
    ...Array.from({ length: 48 }, (_unused, index) => ({ key: "ArrowLeft", expected: 47 - index })),
  ];
  for (const { key, expected } of keys) {
    const before = await page.evaluate(
      () => (Reflect.get(window, "__hcRenders") as { renders: number }).renders,
    );
    await page.keyboard.press(key);
    const after = await page.evaluate(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const harness = Reflect.get(window, "__hcHarness") as {
        map: {
          getFeatureState(target: { source: string; id: string | number }): { v?: unknown };
          getSource(id: string): { serialize(): { data: { features: { id: string | number }[] } } };
        };
        store: { getState(): { sliderFrame: number } };
      };
      const counter = Reflect.get(window, "__hcRenders") as { renders: number };
      const cells = harness.map.getSource("hc-heatmap").serialize().data.features;
      return {
        frame: harness.store.getState().sliderFrame,
        renders: counter.renders,
        // The sum of every corridor cell's value: it moves whenever any cell's state moved.
        cell: cells.reduce((sum, { id }) => {
          const value = harness.map.getFeatureState({ source: "hc-heatmap", id }).v;
          return sum + (typeof value === "number" ? value : 0);
        }, 0),
      };
    });
    steps.push({ expected, frame: after.frame, renders: after.renders - before, cell: after.cell });
  }
  return steps;
}

/** One sweep of the slider, 0 to 48 to 0 hours, by keyboard and then by pointer. */
async function sweep(page: Page): Promise<Record<string, Record<string, number>>> {
  const slider = page.getByRole("slider", { name: "Forecast time" });
  await startProbe(page);
  await slider.focus();
  const steps = await pacedKeyboardSweep(page);
  await expect(slider).toHaveValue("0");
  const keyboard = summarise(await stopProbe(page));
  // Each step applied the frame index it asked for, the sweep was paced at a presented frame per
  // step at least, and the cells changed state across the sweep: the numbers measure scrubbing.
  // A step whose hour changes no cell's value draws nothing (no feature-state write, no repaint),
  // so render counts are recorded, not required.
  expect(steps.map((step) => step.frame)).toEqual(steps.map((step) => step.expected));
  expect(keyboard["frames"]).toBeGreaterThanOrEqual(steps.length);
  expect(new Set(steps.map((step) => step.cell)).size).toBeGreaterThan(1);
  const rendersPerStep = steps.map((step) => step.renders);

  const ticks = await page.locator('[data-scale="ticks"]').boundingBox();
  if (!ticks) throw new Error("the slider scale has no box");
  // The track sits just above the hour ticks.
  const y = ticks.y - 8;
  const at = (hour: number): number => ticks.x + (ticks.width * hour) / 48;
  await startProbe(page);
  await page.mouse.move(at(0), y);
  await page.mouse.down();
  for (let hour = 1; hour <= 48; hour += 1) await page.mouse.move(at(hour), y, { steps: 2 });
  await expect(slider).toHaveValue("48");
  for (let hour = 47; hour >= 0; hour -= 1) await page.mouse.move(at(hour), y, { steps: 2 });
  await page.mouse.up();
  await expect(slider).toHaveValue("0");
  const pointer = summarise(await stopProbe(page));
  return {
    keyboard_sweep: {
      ...keyboard,
      steps: steps.length,
      max_renders_per_step: Math.max(...rendersPerStep),
      steps_without_a_redraw: rendersPerStep.filter((renders) => renders === 0).length,
    },
    pointer_sweep: pointer,
  };
}

/**
 * The scenes the sweep runs on: the harness on the blank basemap (only our layers: heatmap cells,
 * routes, ribbons, checkpoints and trucks), and on the OpenFreeMap basemap users see.
 */
const PERF_SCENES = [
  { name: "blank_basemap", query: "?basemap=blank" },
  { name: "openfreemap_basemap", query: "" },
] as const;

test.describe("R7 smoothness: scrubbing the forecast", () => {
  test.describe.configure({ retries: 0 });

  test(
    "a 0 to 48 to 0 sweep by keyboard and by pointer makes no request, no long task and holds 55 fps",
    { tag: "@perf" },
    async ({ page, browserName }, testInfo) => {
      test.setTimeout(300_000);
      const scenes: Record<string, Record<string, unknown>> = {};
      for (const scene of PERF_SCENES) {
        await openMap(page, "light", scene.query);
        // A number must prove its own workload (D-39): the trip framed and every feature drawn.
        const workload = await readWorkload(page);
        expectRealWorkload(workload);
        const requests: string[] = [];
        const record = (request: { url: () => string }): void => {
          requests.push(request.url());
        };
        page.on("request", record);
        const sweeps = await sweep(page);
        page.off("request", record);
        scenes[scene.name] = {
          workload,
          requests_during_sweeps: requests.length,
          request_urls: requests,
          ...sweeps,
        };
      }

      const renderer = await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const info = gl?.getExtension("WEBGL_debug_renderer_info");
        return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
      });
      const result = {
        measured_at: new Date().toISOString(),
        browser: browserName,
        webgl_renderer: renderer,
        page: "/design/map (fixture trip SLC-DEN, severe-on-fastest, the trip framed)",
        technique: "D-11: cell polygons, one source, per-frame feature-state in one rAF",
        budget: { requests: 0, longest_task_ms: 50, median_frame_ms: 18 },
        scenes,
      };
      const json = JSON.stringify(result, null, 2);
      await testInfo.attach("perf.json", { body: json, contentType: "application/json" });
      const evidence = process.env["PERF_EVIDENCE"];
      if (evidence !== undefined) {
        mkdirSync(dirname(evidence), { recursive: true });
        writeFileSync(evidence, `${json}\n`);
      }

      for (const [name, scene] of Object.entries(scenes)) {
        expect(scene["requests_during_sweeps"], name).toBe(0);
        for (const key of ["keyboard_sweep", "pointer_sweep"]) {
          const sweepResult = scene[key] as Record<string, number>;
          expect(sweepResult["longest_task_ms"], `${name} ${key}`).toBeLessThanOrEqual(50);
          expect(sweepResult["median_frame_ms"], `${name} ${key}`).toBeLessThanOrEqual(18);
        }
      }
    },
  );
});

test.describe("map layout", () => {
  // MapLibre's stylesheet sets `position: relative` on the map element. Unlayered, it beat the
  // component rule that stretches the map over its frame (an unlayered rule outranks every layered
  // one), the element collapsed to 0 px high, and MapLibre drew a 300 px canvas nobody could see.
  test("the map fills its frame, and its canvas fills the map", async ({ page }) => {
    await openMap(page, "light", "?basemap=blank");

    const sizes = await page.getByTestId("map-canvas-container").evaluate((map) => {
      const frame = map.parentElement;
      const canvas = map.querySelector("canvas");
      if (!frame || !canvas) throw new Error("the map has no frame or no canvas");
      const size = (element: Element): number[] => {
        const box = element.getBoundingClientRect();
        return [Math.round(box.width), Math.round(box.height)];
      };
      return { frame: size(frame), map: size(map), canvas: size(canvas) };
    });

    expect(sizes.frame[1]).toBeGreaterThan(300);
    expect(sizes.map).toEqual(sizes.frame);
    expect(sizes.canvas).toEqual(sizes.map);
  });

  // MapLibre's first style load stops the camera animation of a map whose camera has not moved
  // yet. The first framing used to animate, was stopped there, and the map stayed at the world
  // view: every layer was drawn, the whole trip a dozen pixels wide.
  test("frames the trip as asked and draws every route, stretch, checkpoint and cell", async ({
    page,
  }) => {
    await openMap(page, "light", "?basemap=blank");

    expectRealWorkload(await readWorkload(page));
  });

  test("frames the trip: both pins inside the map and far apart", async ({ page }) => {
    await openMap(page, "light", "?basemap=blank");

    const frame = await page.getByTestId("map-canvas-container").boundingBox();
    const origin = await page.getByRole("img", { name: "Origin: Salt Lake City" }).boundingBox();
    const destination = await page.getByRole("img", { name: "Destination: Denver" }).boundingBox();
    if (!frame || !origin || !destination) throw new Error("the map or a pin has no box");
    const pins = [origin, destination].map((box) => ({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    }));

    for (const pin of pins) {
      expect(pin.x).toBeGreaterThan(frame.x);
      expect(pin.x).toBeLessThan(frame.x + frame.width);
      expect(pin.y).toBeGreaterThan(frame.y);
      expect(pin.y).toBeLessThan(frame.y + frame.height);
    }
    const [from, to] = pins;
    expect(Math.abs((to?.x ?? 0) - (from?.x ?? 0))).toBeGreaterThan(frame.width / 3);
  });

  test("without WebGL 2 the map says it is unavailable, and the page keeps working", async ({
    page,
  }) => {
    // As in a browser with hardware acceleration off: no WebGL 2 context for any canvas.
    await page.addInitScript(() => {
      const original: unknown = Reflect.get(HTMLCanvasElement.prototype, "getContext");
      if (typeof original !== "function") throw new Error("this browser has no canvas contexts");
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        value(this: HTMLCanvasElement, ...args: unknown[]): unknown {
          return args[0] === "webgl2" ? null : Reflect.apply(original, this, args);
        },
      });
    });

    await page.goto("/design/map?basemap=blank");

    await expect(page.getByText("Map unavailable")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Map harness" })).toBeVisible();
    await expect(page.getByRole("slider", { name: "Forecast time" })).toBeVisible();
  });
});

test.describe("map accessibility", () => {
  for (const theme of THEMES) {
    test(`has no axe violation in the ${theme} theme`, async ({ page }) => {
      await openMap(page, theme, "?basemap=blank");

      const results = await new AxeBuilder({ page }).analyze();

      expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual(
        [],
      );
    });
  }

  test("names the map region and describes the plan to screen readers", async ({ page }) => {
    await openMap(page, "light", "?basemap=blank");

    const canvas = page.getByRole("region", { name: "Route map" });
    await expect(canvas).toBeVisible();
    const describedBy = (await canvas.getAttribute("aria-describedby")) ?? "";
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText("Plan ready.");
  });
});

// Goldens are tagged `@golden` and compared on the Linux runner of CI only (playwright.config.ts
// and e2e/design-system.spec.ts explain why); the blank basemap keeps third-party tiles out.
test.describe("map visual goldens", () => {
  test.skip(
    process.platform !== "linux",
    "goldens are made and enforced on Linux (CI); run the Update visual goldens workflow to refresh them",
  );
  test.describe.configure({ retries: 0 });

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test.describe(`/design/map, ${theme}, ${viewport.name} (${String(viewport.width)} px)`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } });

        test("matches the visual golden", { tag: "@golden" }, async ({ page }) => {
          await openMap(page, theme, "?basemap=blank");

          await expect(page).toHaveScreenshot(`map-${theme}-${viewport.name}.png`, {
            fullPage: true,
            animations: "disabled",
          });
        });
      });
    }
  }
});
