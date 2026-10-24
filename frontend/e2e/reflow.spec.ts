import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { openPlanner } from "./support/planner";

// E2-F1: WCAG 1.4.10 Reflow. DESIGN.md says that at 400% zoom (1280 px wide, which is 320 CSS px)
// the mobile layout applies and nothing is clipped. The departure date and time were clipped from
// about 384 px down: each segment is as wide as the widest text it can show (R4-01: the code taking
// over moves nothing), and the two fields sat in fixed 3fr / 2fr columns that cannot hold that text
// on a narrow phone. This spec opens the empty planner at four widths and reads what the browser
// laid out. 390 px is the control: the width of the visual goldens, where both fields fit already.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

// A measurement that needs a second try to pass is a flaky measurement, not a passing one.
test.describe.configure({ retries: 0 });

/** The widths of the check, and the one above which the date and the time share a row. */
const WIDTHS = [320, 360, 375, 390] as const;
const ONE_ROW_FROM = 390;

/** What the page laid out for one field of the departure: a date or a time, as segments in a box. */
interface FieldFit {
  /** The width of the box that clips the segments. */
  readonly box: number;
  /** Its `clientWidth` and `scrollWidth`: the second is larger when the segments need more room. */
  readonly client: number;
  readonly scroll: number;
  /** The width of the segments together: the widest text they can show. */
  readonly content: number;
  /** The segments whose box leaves the visible box of the group, and by how many px. */
  readonly outside: readonly string[];
  /** Where the field's box starts, from the top of the window. */
  readonly top: number;
}

/** What else the page says: how far it scrolls sideways and which elements a clipping box cuts. */
interface PageFit {
  readonly viewportWidth: number;
  readonly pageWidth: number;
  readonly clipped: readonly string[];
}

/** A field that has been measured, with its name. */
interface NamedFit extends FieldFit {
  readonly name: "Date" | "Time";
}

/** Everything one width measures. */
interface Reflow extends PageFit {
  readonly fields: readonly NamedFit[];
}

/**
 * Runs in the page, on the group of a date or a time field: the box that clips its segments (the
 * element that holds them) against the segments themselves.
 *
 * @param group - The field's `role="group"` element.
 */
function fitOf(group: HTMLElement): FieldFit {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const segments = [...group.querySelectorAll<HTMLElement>("[data-type]")];
  const box = segments[0]?.parentElement;
  if (box === undefined || box === null) throw new Error("A date or a time field has no segments.");
  const edge = box.getBoundingClientRect();
  const style = getComputedStyle(box);
  // What `overflow: hidden` shows: the padding box.
  const visibleLeft = edge.left + Number.parseFloat(style.borderLeftWidth);
  const visibleRight = edge.right - Number.parseFloat(style.borderRightWidth);
  return {
    box: round(edge.width),
    client: box.clientWidth,
    scroll: box.scrollWidth,
    content: round(
      segments.reduce((total, segment) => total + segment.getBoundingClientRect().width, 0),
    ),
    outside: segments.flatMap((segment) => {
      const rect = segment.getBoundingClientRect();
      const past = Math.max(visibleLeft - rect.left, rect.right - visibleRight);
      // Half a pixel is layout's own rounding; more is text that is cut off.
      return past > 0.5
        ? [`${segment.dataset["type"] ?? "segment"}: ${String(round(past))} px`]
        : [];
    }),
    top: round(group.getBoundingClientRect().top),
  };
}

/**
 * Runs in the page: how far the page scrolls sideways, and every element of the planner's panel
 * that a box which clips sideways cuts off (its nearest one: a segment in its date input, a field
 * in the sheet). A box of one pixel is a visually hidden helper (the hidden date input, the hidden
 * select), which sits and cuts where it is on purpose.
 */
function pageFit(): PageFit {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const label = (element: Element): string => {
    const classes = [...element.classList]
      .map((name) => name.replace(/^_|_[a-z0-9]+_\d+$/gu, ""))
      .join(".");
    return `${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`}`;
  };
  const panel = document.querySelector("[data-planner-panel]");
  const clipped = new Set<string>();
  for (const element of panel?.querySelectorAll("*") ?? []) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height === 0) continue;
    let clip = element.parentElement;
    while (clip !== null && getComputedStyle(clip).overflowX === "visible") {
      clip = clip.parentElement;
    }
    if (clip === null) continue;
    const edge = clip.getBoundingClientRect();
    if (edge.width <= 1 || edge.height <= 1) continue;
    const style = getComputedStyle(clip);
    const left = edge.left + Number.parseFloat(style.borderLeftWidth);
    const right = edge.right - Number.parseFloat(style.borderRightWidth);
    const past = Math.max(left - rect.left, rect.right - right);
    if (past > 0.5) {
      clipped.add(`${label(element)} in ${label(clip)}: ${String(round(past))} px`);
    }
  }
  const scrolling = document.scrollingElement;
  return {
    viewportWidth: window.innerWidth,
    pageWidth: scrolling === null ? 0 : scrolling.scrollWidth,
    clipped: [...clipped],
  };
}

/** Measures the date, the time and the page. */
async function measure(page: Page): Promise<Reflow> {
  const date = await page.getByRole("group", { name: "Date", exact: true }).evaluate(fitOf);
  const time = await page.getByRole("group", { name: "Time", exact: true }).evaluate(fitOf);
  return {
    ...(await page.evaluate(pageFit)),
    fields: [
      { ...date, name: "Date" },
      { ...time, name: "Time" },
    ],
  };
}

/** The measurements as one line per field, for the report and for the failure message. */
function describe(width: number, reflow: Reflow): string {
  const lines = reflow.fields.map(
    (field) =>
      `${field.name}: box ${String(field.box)} px (client ${String(field.client)}, scroll ${String(field.scroll)}), ` +
      `segments ${String(field.content)} px, outside the box: ${field.outside.join("; ") || "none"}`,
  );
  return [
    `at ${String(width)} px: the window is ${String(reflow.viewportWidth)} px, the page ${String(reflow.pageWidth)} px`,
    ...lines,
    `clipped elsewhere: ${reflow.clipped.join("; ") || "none"}`,
  ].join("\n");
}

/** What does not fit. Empty when every field fits its box at that width. */
function problems(width: number, reflow: Reflow): string[] {
  const found = reflow.fields.flatMap((field) => [
    ...(field.scroll > field.client
      ? [
          `${field.name}: the segments need ${String(field.scroll)} px, the box has ${String(field.client)} px`,
        ]
      : []),
    ...field.outside.map((segment) => `${field.name}: the ${segment} is outside the box`),
  ]);
  if (reflow.pageWidth > reflow.viewportWidth) {
    found.push(
      `the page scrolls sideways: ${String(reflow.pageWidth)} px in a ${String(reflow.viewportWidth)} px window`,
    );
  }
  found.push(...reflow.clipped.map((element) => `clipped: ${element}`));
  const [date, time] = reflow.fields;
  if (
    date !== undefined &&
    time !== undefined &&
    width >= ONE_ROW_FROM &&
    Math.abs(time.top - date.top) > 1
  ) {
    found.push(
      `the time is not beside the date: ${String(time.top)} px and ${String(date.top)} px from the top`,
    );
  }
  return found;
}

test.describe("the departure date and time", () => {
  for (const width of WIDTHS) {
    test(`fit their boxes, and the page does not scroll sideways, at ${String(width)} px`, async ({
      page,
    }) => {
      // The width of the window changes; the height and the device are the project's own.
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("The project has no viewport.");
      await page.setViewportSize({ width, height: viewport.height });
      await openPlanner(page);

      const reflow = await measure(page);
      const report = describe(width, reflow);
      await test.info().attach("reflow", { body: report, contentType: "text/plain" });
      console.log(`reflow ${report.replaceAll("\n", " | ")}`);

      expect(problems(width, reflow), report).toEqual([]);
    });
  }
});
