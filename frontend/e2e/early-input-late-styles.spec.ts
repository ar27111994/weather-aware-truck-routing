import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { holdStylesheets } from "./support/late-styles";
import { NOW, chooseTrip, holdPlannerCode } from "./support/planner";

// K6, kept shut (R4-01). A first tap on Plan routes was lost in Firefox about one run in two: the
// page's first input starts the download of the planner's code, the stylesheets that come with
// that code arrived between the pointer going down and the pointer coming up, the page was laid
// out again, Plan routes moved 30 px, and the pointer came up on the form's stack. A click goes to
// the common ancestor of the two, so the button got none. The fix is that the prerendered planner
// is drawn in its own styles from the first paint: nothing that arrives later moves a control.
//
// That holds only while the shell's stylesheet stays linked in the prerender and no style that
// loads with the first input moves a control, and the natural timing of a runner shows a failure
// one run in a hundred at the most. So this spec makes the worst case happen on purpose, for
// every control that early-input.spec.ts taps before the planner has arrived: the stylesheets that
// the first input asks for are held back with `page.route` (support/late-styles.ts), the pointer
// goes down on the control, the stylesheets are released and drawn, and only then does the pointer
// go up. Each test checks two things:
//  - the control's box is the same when the pointer goes down and when it comes up;
//  - the tap has the effect that the early-input test of that control asserts.
// The second is the one the visitor feels. The first fails on every layout shift, also on one that
// leaves the pointer on the control, and says by how much the control moved.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;
const TO = /^To/u;
const REQUIRED = "Choose a starting point from the list.";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What a tap is aimed at, and what it must have done. */
interface Tap {
  /** The control the pointer goes down on. */
  readonly target: Locator;
  /** What the tap has done while the planner's code is still on its way (nothing, mostly). */
  readonly whileLoading?: () => Promise<void>;
  /** What the tap has done once the planner's code has taken the page over. */
  readonly afterHydration: () => Promise<void>;
}

/**
 * A control that early-input.spec.ts taps before the planner's code has arrived. `prepare` does
 * what the early-input test does before the tap, typing included: a key press is an input of its
 * own, and it is the one that starts the download.
 */
interface Control {
  /** The control, named for the title of its test. */
  readonly name: string;
  readonly prepare: (page: Page) => Promise<Tap>;
}

const CONTROLS: readonly Control[] = [
  {
    // "tapping Plan routes changes nothing before hydration, and checks the form once after it"
    name: "Plan routes",
    prepare: async (page) => {
      const history = await page.evaluate(() => window.history.length);
      return {
        target: page.getByRole("button", { name: "Plan routes" }),
        whileLoading: async () => {
          expect(new URL(page.url()).search).toBe("");
          expect(await page.evaluate(() => window.history.length)).toBe(history);
        },
        afterHydration: () => expect(page.getByText(REQUIRED)).toHaveCount(1),
      };
    },
  },
  {
    // "tapping a departure chip before hydration sets the departure once, after it"
    name: "the +3 h departure chip",
    prepare: async (page) => {
      const chip = page.getByRole("button", { name: "+3 h" });
      // A disabled button fires no click, so the press would be lost (R4-08).
      await expect(chip).toBeEnabled();
      return {
        target: chip,
        // The clock reads 9:00; the chip adds three hours. A lost tap leaves the time empty.
        afterHydration: () =>
          expect(page.getByRole("group", { name: "Time" }).getByRole("spinbutton")).toHaveText([
            "12",
            "00",
            "PM",
          ]),
      };
    },
  },
  {
    // "choosing the 10 mile interval is kept, and the plan request uses it"
    name: "the 10 mi interval",
    prepare: async (page) => {
      const ten = page.getByRole("radio", { name: "10 mi" });
      await expect(ten).not.toBeChecked();
      return {
        target: page.getByText("10 mi", { exact: true }),
        whileLoading: () => expect(ten).toBeChecked(),
        afterHydration: async () => {
          await expect(ten).toBeChecked();
          await chooseTrip(page);
          const planned = page.waitForRequest(
            (request) => request.method() === "POST" && request.url().endsWith("/api/v1/plans"),
          );
          await page.getByRole("button", { name: "Plan routes" }).click();
          expect(
            ((await planned).postDataJSON() as { sampling_interval_mi: number })
              .sampling_interval_mi,
          ).toBe(10);
        },
      };
    },
  },
  {
    // "tapping a load stepper after typing a load applies the tap once"
    name: "the load stepper",
    prepare: async (page) => {
      const load = page.getByRole("textbox", { name: /^Load weight/u });
      await load.pressSequentially("5000");
      return {
        target: page.getByRole("button", { name: "Increase load by 1,000 lb" }),
        // 5,000 plus one step. A tap that was lost leaves 5,000; one applied twice makes 7,000.
        afterHydration: () => expect(load).toHaveValue("6,000"),
      };
    },
  },
  {
    // "swapping two typed places swaps them once"
    name: "the swap button",
    prepare: async (page) => {
      await page.getByRole("combobox", { name: FROM }).pressSequentially("Aaa");
      await page.getByRole("combobox", { name: TO }).pressSequentially("Bbb");
      return {
        target: page.getByRole("button", { name: "Swap origin and destination" }),
        // Swapped once. Applied twice they would be back where they started.
        afterHydration: async () => {
          await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("Bbb");
          await expect(page.getByRole("combobox", { name: TO })).toHaveValue("Aaa");
        },
      };
    },
  },
];

const hydrated = (page: Page): Promise<void> =>
  expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");

const settled = (page: Page): Promise<void> =>
  expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);

/** Where a control is on the page now: it must be on it. */
async function boxOf(control: Locator): Promise<Box> {
  const box = await control.boundingBox();
  if (box === null) throw new Error("The control has no box: it is not on the page.");
  return box;
}

test.describe("a first tap that lands while the planner's styles are still arriving", () => {
  for (const control of CONTROLS) {
    test(`${control.name} stays under the pointer, and the tap counts`, async ({ page }) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      const code = await holdPlannerCode(page);
      const styles = await holdStylesheets(page);
      await page.clock.setFixedTime(NOW);
      await page.goto("/");
      // The page's own stylesheets are in. The ones that the first input asks for wait.
      styles.hold();

      const tap = await control.prepare(page);
      await tap.target.scrollIntoViewIfNeeded();
      const aimed = await boxOf(tap.target);
      // A move over the panel is a first input too: for a control with nothing typed before it,
      // this is the one that asks for the planner's code and its styles.
      await page.mouse.move(aimed.x + aimed.width / 2, aimed.y + aimed.height / 2);
      await expect
        .poll(styles.count, {
          message:
            "stylesheets held back after the first input: the planner's styles no longer arrive " +
            "with it, so there is nothing for this test to delay (replace it by a check that " +
            "the first input asks for none)",
        })
        .toBeGreaterThan(0);

      await page.mouse.down();
      const atDown = await boxOf(tap.target);
      await styles.release();
      const atUp = await boxOf(tap.target);
      expect.soft(atUp, `${control.name} moved while the pointer was down`).toEqual(atDown);
      await page.mouse.up();

      await expect.poll(code.requested).toBe(true);
      await tap.whileLoading?.();
      await code.release();
      await hydrated(page);
      await settled(page);
      await tap.afterHydration();
      expect(problems).toEqual([]);
    });
  }
});
