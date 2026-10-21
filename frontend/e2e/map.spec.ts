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

test.describe("R7 smoothness: scrubbing the forecast", () => {
  test.describe.configure({ retries: 0 });

  test(
    "a 0 to 48 to 0 sweep by keyboard and by pointer makes no request, no long task and holds 55 fps",
    { tag: "@perf" },
    async ({ page, browserName }, testInfo) => {
      test.setTimeout(180_000);
      await openMap(page, "light");
      const slider = page.getByRole("slider", { name: "Forecast time" });
      const requests: string[] = [];
      page.on("request", (request) => {
        requests.push(request.url());
      });

      await startProbe(page);
      await slider.focus();
      for (let hour = 0; hour < 48; hour += 1) await page.keyboard.press("ArrowRight");
      await expect(slider).toHaveValue("48");
      for (let hour = 0; hour < 48; hour += 1) await page.keyboard.press("ArrowLeft");
      await expect(slider).toHaveValue("0");
      const keyboard = summarise(await stopProbe(page));

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

      const result = {
        measured_at: new Date().toISOString(),
        browser: browserName,
        page: "/design/map (OpenFreeMap basemap, fixture trip SLC-DEN, severe-on-fastest)",
        technique: "D-11: cell polygons, one source, per-frame feature-state in one rAF",
        budget: { requests: 0, longest_task_ms: 50, median_frame_ms: 18 },
        requests_during_sweeps: requests.length,
        request_urls: requests,
        keyboard_sweep: keyboard,
        pointer_sweep: pointer,
      };
      const json = JSON.stringify(result, null, 2);
      await testInfo.attach("perf.json", { body: json, contentType: "application/json" });
      const evidence = process.env["PERF_EVIDENCE"];
      if (evidence !== undefined) {
        mkdirSync(dirname(evidence), { recursive: true });
        writeFileSync(evidence, `${json}\n`);
      }

      expect(requests).toEqual([]);
      for (const sweep of [keyboard, pointer]) {
        expect(sweep["longest_task_ms"]).toBeLessThanOrEqual(50);
        expect(sweep["median_frame_ms"]).toBeLessThanOrEqual(18);
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
