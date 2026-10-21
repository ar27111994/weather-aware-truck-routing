// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { attributeSweep, isSoftwareRenderer, summariseSweep } from "./trace-attribution.ts";
import type { TraceEvent } from "./trace-attribution.ts";

/**
 * A real trace, trimmed: three paced slider steps on `/design/map` in Playwright's headless shell
 * (SwiftShader, software compositing; categories toplevel, cc, gpu), plus the first longer task
 * without a readback. Its facts, read off the raw events: tasks of 67.737, 65.384 and 65.249 ms
 * whose commits read back for 56.680, 56.844 and 57.208 ms, and a 1.759 ms task before them.
 */
const FIXTURE: TraceEvent[] = (
  JSON.parse(readFileSync(new URL("./fixtures/sweep-trace.json", import.meta.url), "utf8")) as {
    traceEvents: TraceEvent[];
  }
).traceEvents;

const ms = (values: readonly number[]): number[] => values.map((value) => Number(value.toFixed(3)));

function renamed(events: readonly TraceEvent[], from: string, to: string, nth = 0): TraceEvent[] {
  let seen = -1;
  return events.map((event) => {
    if (event.name !== from) return event;
    seen += 1;
    return seen === nth ? { ...event, name: to } : event;
  });
}

describe("attributeSweep", () => {
  it("takes each commit's readback off its task, and nothing else", () => {
    const sweep = attributeSweep(FIXTURE);

    expect(ms(sweep.tasks.map((task) => task.rawMs))).toEqual([1.759, 67.737, 65.384, 65.249]);
    expect(ms(sweep.tasks.map((task) => task.readbackMs))).toEqual([0, 56.68, 56.844, 57.208]);
    // Raw minus the readback alone: page JS, MapLibre, style, layout and the rest of the commit
    // stay counted (taking every descendant off would leave almost nothing).
    expect(ms(sweep.tasks.map((task) => task.correctedMs))).toEqual([1.759, 11.057, 8.54, 8.041]);
    expect(sweep.readbacks).toBe(3);
    expect(Number(sweep.readbackMs.toFixed(3))).toBe(170.732);
  });

  it("does not reduce a readback outside a commit, such as one the page calls itself", () => {
    const sweep = attributeSweep(renamed(FIXTURE, "LayerTreeHost::DoUpdateLayers", "FunctionCall"));

    expect(ms(sweep.tasks.map((task) => task.correctedMs))).toEqual([1.759, 67.737, 8.54, 8.041]);
    expect(sweep.readbacks).toBe(2);
  });

  it("counts a readback nested in another readback once", () => {
    const outer = FIXTURE.find((event) => event.name === "GLES2::ReadPixels");
    if (outer?.dur === undefined) throw new Error("the fixture has a readback");
    const inner: TraceEvent = { ...outer, ts: outer.ts + 10, dur: outer.dur - 20 };

    const sweep = attributeSweep([...FIXTURE, inner]);

    expect(ms(sweep.tasks.map((task) => task.correctedMs))).toEqual([1.759, 11.057, 8.54, 8.041]);
    expect(sweep.readbacks).toBe(3);
  });

  it("splits the main thread into presented frames, each owning the tasks until the next", () => {
    const sweep = attributeSweep(FIXTURE);

    // The 1.759 ms task ran before the first frame of the trace, so no frame owns it.
    expect(sweep.frames.map((frame) => frame.tasks)).toEqual([1, 1, 1]);
    expect(ms(sweep.frames.map((frame) => frame.rawMs))).toEqual([67.737, 65.384, 65.249]);
    expect(ms(sweep.frames.map((frame) => frame.correctedMs))).toEqual([11.057, 8.54, 8.041]);
  });

  it("does not count a begin-main-frame that never committed as presented", () => {
    const sweep = attributeSweep(renamed(FIXTURE, "ProxyMain::BeginMainFrame::commit", "Idle", 1));

    expect(sweep.frames.map((frame) => frame.tasks)).toEqual([2, 1]);
    expect(ms(sweep.frames.map((frame) => frame.correctedMs))).toEqual([19.597, 8.041]);
  });

  it("ignores a commit marker outside any begin-main-frame", () => {
    const sweep = attributeSweep(renamed(FIXTURE, "ProxyMain::BeginMainFrame", "Other", 1));

    expect(sweep.frames.map((frame) => frame.tasks)).toEqual([2, 1]);
  });

  it("starts a frame at its begin-main-frame when tracing began inside the frame's task", () => {
    // Tracing that starts mid-task records the task's children but not the task.
    const second = FIXTURE.filter((event) => event.name === "ThreadControllerImpl::RunTask")[2];
    const sweep = attributeSweep(FIXTURE.filter((event) => event !== second));

    expect(sweep.frames.map((frame) => frame.tasks)).toEqual([1, 0, 1]);
    // Its readback has no task to come off, so it is not counted either.
    expect(sweep.readbacks).toBe(2);
    expect(ms(sweep.tasks.map((task) => task.correctedMs))).toEqual([1.759, 11.057, 8.041]);
  });

  it("reads the renderer main thread only", () => {
    const task = FIXTURE.find((event) => event.name === "ThreadControllerImpl::RunTask");
    if (!task) throw new Error("the fixture has a task");
    const elsewhere: TraceEvent[] = [
      { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 2, args: { name: "Compositor" } },
      { ...task, pid: 1, tid: 2, dur: 500_000 },
    ];

    expect(attributeSweep([...FIXTURE, ...elsewhere]).tasks).toHaveLength(4);
    expect(attributeSweep(elsewhere)).toEqual({
      tasks: [],
      frames: [],
      readbacks: 0,
      readbackMs: 0,
    });
  });
});

describe("summariseSweep", () => {
  it("reports raw and corrected maxima and per-frame medians, and the readbacks", () => {
    expect(summariseSweep(attributeSweep(FIXTURE))).toEqual({
      frames: 3,
      readbacks: 3,
      readback_ms: 170.73,
      raw: { longest_task_ms: 67.74, median_frame_ms: 65.38 },
      corrected: { longest_task_ms: 11.06, median_frame_ms: 8.54 },
    });
  });

  it("takes the mean of the middle pair for an even number of frames", () => {
    // Without the third frame's commit its task joins the second frame: 11.057 and 16.581 ms.
    const sweep = attributeSweep(renamed(FIXTURE, "ProxyMain::BeginMainFrame::commit", "Idle", 2));

    expect(summariseSweep(sweep).corrected.median_frame_ms).toBe(13.82);
  });

  it("refuses a trace without a presented frame: a budget must not pass on no work", () => {
    expect(() => summariseSweep(attributeSweep([]))).toThrow(/no presented frame/);
  });
});

describe("isSoftwareRenderer", () => {
  it("knows the software rasterisers by their WebGL renderer strings", () => {
    for (const renderer of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "softpipe",
      "Mesa Software Rasterizer",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ]) {
      expect(isSoftwareRenderer(renderer), renderer).toBe(true);
    }
    expect(
      isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"),
    ).toBe(false);
  });
});
