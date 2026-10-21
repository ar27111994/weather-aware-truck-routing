/**
 * Main-thread time of a slider sweep, read from a Chrome trace (D-39, the CI tier of R7).
 *
 * With a software renderer Chromium also composites in software, and in each frame's commit the
 * compositor reads the WebGL canvas back on the renderer main thread: `LayerTreeHost::DoUpdateLayers`
 * (the commit's layer update, shown as "Commit" in DevTools) calls `GLES2::ReadPixels`, which waits
 * in `CommandBufferHelper::Finish` until the software rasteriser has drawn the frame. That wait
 * measures the rasteriser, and a browser with a GPU never makes it. So a task's corrected time is
 * its raw time minus the outermost readbacks under a commit, and nothing else is taken off: page
 * JavaScript, MapLibre, input, style, layout, paint and the rest of the commit all count, and a
 * readback the page itself makes is not under a commit, so it counts too.
 *
 * Per-frame attribution: a presented frame starts with the main-thread task that runs its
 * `ProxyMain::BeginMainFrame` (one that reached `ProxyMain::BeginMainFrame::commit`) and owns every
 * task that starts before the next presented frame's task. Tasks before the first presented frame
 * belong to no frame.
 */

/** A Chrome trace event: the fields the attribution reads. Times are in microseconds. */
export interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly cat?: string;
  readonly args?: { readonly name?: string };
}

/** One renderer main-thread task, in milliseconds. */
export interface TaskTime {
  readonly startUs: number;
  readonly rawMs: number;
  readonly readbackMs: number;
  readonly correctedMs: number;
}

/** The main-thread time one presented frame owns, in milliseconds. */
export interface FrameTime {
  readonly rawMs: number;
  readonly correctedMs: number;
  readonly tasks: number;
}

/** What {@link attributeSweep} reads from a trace. */
export interface SweepAttribution {
  readonly tasks: TaskTime[];
  readonly frames: FrameTime[];
  /** Readbacks taken off (outermost, under a commit). */
  readonly readbacks: number;
  readonly readbackMs: number;
}

/** The longest task and the median frame, raw and corrected, in milliseconds (2 dp). */
export interface SweepBudget {
  readonly longest_task_ms: number;
  readonly median_frame_ms: number;
}

/** What `perf.json` keeps of a sweep's trace. */
export interface SweepSummary {
  readonly frames: number;
  readonly readbacks: number;
  readonly readback_ms: number;
  readonly raw: SweepBudget;
  readonly corrected: SweepBudget;
}

const MAIN_THREAD = "CrRendererMain";
const TASK = "ThreadControllerImpl::RunTask";
const BEGIN_FRAME = "ProxyMain::BeginMainFrame";
const FRAME_COMMITTED = "ProxyMain::BeginMainFrame::commit";
const COMMIT = "LayerTreeHost::DoUpdateLayers";
const READBACK = "GLES2::ReadPixels";
/** WebGL renderer strings of software rasterisers (`UNMASKED_RENDERER_WEBGL`). */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const US_PER_MS = 1000;

type Complete = TraceEvent & { readonly dur: number };

interface Node {
  readonly event: Complete;
  readonly parent: Node | undefined;
}

/** Whether a WebGL renderer string names a software rasteriser rather than a GPU. */
export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE_RENDERER.test(renderer);
}

function contains(outer: Complete, inner: Complete): boolean {
  return inner.ts >= outer.ts && inner.ts + inner.dur <= outer.ts + outer.dur;
}

/** The outermost of `node` and its ancestors that is called `name`, if any. */
function outermost(node: Node, name: string): Node | undefined {
  let found: Node | undefined;
  for (let at: Node | undefined = node; at; at = at.parent) {
    if (at.event.name === name) found = at;
  }
  return found;
}

function hasAncestor(node: Node, name: string): boolean {
  return node.parent !== undefined && outermost(node.parent, name) !== undefined;
}

/** The renderer main thread's complete events as a forest, parents before their children. */
function mainThreadNodes(events: readonly TraceEvent[]): Node[] {
  const threads = new Set(
    events
      .filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === MAIN_THREAD)
      .map((e) => `${String(e.pid)}:${String(e.tid)}`),
  );
  const complete = events
    .filter(
      (e): e is Complete =>
        e.ph === "X" && e.dur !== undefined && threads.has(`${String(e.pid)}:${String(e.tid)}`),
    )
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stacks = new Map<string, Node[]>();
  return complete.map((event) => {
    const thread = `${String(event.pid)}:${String(event.tid)}`;
    const stack = stacks.get(thread) ?? [];
    let parent = stack[stack.length - 1];
    while (parent && !contains(parent.event, event)) {
      stack.pop();
      parent = stack[stack.length - 1];
    }
    const node: Node = { event, parent };
    stack.push(node);
    stacks.set(thread, stack);
    return node;
  });
}

/** Tasks, presented frames and readbacks of a sweep's trace; see the module comment. */
export function attributeSweep(events: readonly TraceEvent[]): SweepAttribution {
  const nodes = mainThreadNodes(events);
  const readbackUs = new Map<Node, number>();
  let readbacks = 0;
  let readbackTotal = 0;
  for (const node of nodes) {
    if (node.event.name !== READBACK || hasAncestor(node, READBACK) || !hasAncestor(node, COMMIT)) {
      continue;
    }
    const task = outermost(node, TASK);
    if (!task) continue;
    readbackUs.set(task, (readbackUs.get(task) ?? 0) + node.event.dur);
    readbacks += 1;
    readbackTotal += node.event.dur;
  }

  const taskNodes = nodes.filter((node) => node.event.name === TASK && !hasAncestor(node, TASK));
  const tasks = taskNodes.map((node): TaskTime => {
    const readback = readbackUs.get(node) ?? 0;
    return {
      startUs: node.event.ts,
      rawMs: node.event.dur / US_PER_MS,
      readbackMs: readback / US_PER_MS,
      correctedMs: (node.event.dur - readback) / US_PER_MS,
    };
  });

  // A frame starts at the task that runs a begin-main-frame which reached its commit.
  const frameStarts = [
    ...new Set(
      nodes
        .filter((node) => node.event.name === FRAME_COMMITTED)
        .map((node) => outermost(node, BEGIN_FRAME))
        .map((frame) => (frame ? (outermost(frame, TASK) ?? frame).event.ts : undefined))
        .filter((start): start is number => start !== undefined),
    ),
  ].sort((a, b) => a - b);
  const frames = frameStarts.map((start, index): FrameTime => {
    const end = frameStarts[index + 1] ?? Number.POSITIVE_INFINITY;
    const owned = tasks.filter((task) => task.startUs >= start && task.startUs < end);
    return {
      rawMs: owned.reduce((sum, task) => sum + task.rawMs, 0),
      correctedMs: owned.reduce((sum, task) => sum + task.correctedMs, 0),
      tasks: owned.length,
    };
  });

  return { tasks, frames, readbacks, readbackMs: readbackTotal / US_PER_MS };
}

function median(values: readonly number[]): number {
  // The middle value, or the mean of the middle pair: the values at the lower and upper middle
  // index, which are one index for an odd count.
  const sorted = [...values].sort((a, b) => a - b);
  const lower = Math.floor((sorted.length - 1) / 2);
  const upper = Math.ceil((sorted.length - 1) / 2);
  const middle = sorted.filter((_value, index) => index === lower || index === upper);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * The numbers a sweep is judged by: the longest task and the median frame, raw and corrected.
 *
 * @throws {RangeError} when the trace holds no presented frame: a sweep that drew nothing must
 *   fail its budget, never pass it on zero work.
 */
export function summariseSweep(sweep: SweepAttribution): SweepSummary {
  if (sweep.frames.length === 0) {
    throw new RangeError("The trace has no presented frame, so there is no work to judge.");
  }
  return {
    frames: sweep.frames.length,
    readbacks: sweep.readbacks,
    readback_ms: round(sweep.readbackMs),
    raw: {
      longest_task_ms: round(Math.max(...sweep.tasks.map((task) => task.rawMs))),
      median_frame_ms: round(median(sweep.frames.map((frame) => frame.rawMs))),
    },
    corrected: {
      longest_task_ms: round(Math.max(...sweep.tasks.map((task) => task.correctedMs))),
      median_frame_ms: round(median(sweep.frames.map((frame) => frame.correctedMs))),
    },
  };
}
