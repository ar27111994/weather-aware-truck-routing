import type { Page, Route } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, chooseTrip, openPlanner, tripAddress } from "./support/planner";

// Intent-gated hydration of the planner (D-46, ADR 0007) and the one-element panel (D-47). The
// prerendered page is plain HTML; the planner's code is a separate download that starts when the
// visitor first gives the page an input. Every test here holds that download back with `page.route`
// until the visitor is done, then lets it through, and checks what the visitor did survived: what
// was typed or chosen is still there, a press or a submit takes effect exactly once, focus stays,
// and the form is the very same DOM node. No test loads the code any other way than a real input.
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const PLANNER_CODE = /\/assets\/PlannerApp-[\w-]+\.js(?:\?.*)?$/u;
const FROM = /^From/u;
const TO = /^To/u;
const REQUIRED = "Choose a starting point from the list.";

/** The planner's code, held back until the test lets it through. */
interface HeldCode {
  /** The page has asked for the code. */
  readonly requested: () => boolean;
  /** Lets the held request, and any later one, through. */
  readonly release: () => Promise<void>;
}

async function holdPlannerCode(page: Page): Promise<HeldCode> {
  const held: Route[] = [];
  let released = false;
  let requested = false;
  await page.route(PLANNER_CODE, (route) => {
    requested = true;
    if (released) void route.continue();
    else held.push(route);
  });
  return {
    requested: () => requested,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

/** Opens the prerendered page with the planner's code held, watching for errors the page logs. */
async function openHeld(
  page: Page,
  address = "/",
): Promise<{ held: HeldCode; problems: string[] }> {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const held = await holdPlannerCode(page);
  await page.clock.setFixedTime(NOW);
  await page.goto(address);
  return { held, problems };
}

/** Marks the form, the two place fields and the chain of elements around the first, before hydration. */
async function markNodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll("form input[role='combobox']"));
    const chain: Element[] = [];
    for (let node = fields.at(0) ?? null; node !== null; node = node.parentElement)
      chain.push(node);
    Reflect.set(window, "chainBefore", chain);
    Reflect.set(window, "formBefore", document.querySelector("form"));
    Reflect.set(window, "fieldsBefore", fields);
  });
}

/** Whether the form, the fields and everything around the first field are the nodes marked before. */
async function nodesAreTheSame(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const chain = Reflect.get(window, "chainBefore") as Element[];
    const fields = Reflect.get(window, "fieldsBefore") as Element[];
    const now = Array.from(document.querySelectorAll("form input[role='combobox']"));
    let node: Element | null = now.at(0) ?? null;
    for (const before of chain) {
      if (node !== before) return false;
      node = node.parentElement;
    }
    return (
      document.querySelector("form") === Reflect.get(window, "formBefore") &&
      now.length === fields.length &&
      now.every((field, index) => field === fields[index])
    );
  });
}

const hydrated = (page: Page): Promise<void> =>
  expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");

const settled = (page: Page): Promise<void> =>
  expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);

test.describe("input made before the planner's code arrives", () => {
  test("typing into Origin keeps the whole text, and the search carries it", async ({
    page,
    backend,
  }) => {
    const { held, problems } = await openHeld(page);
    await markNodes(page);
    const from = page.getByRole("combobox", { name: FROM });

    await from.pressSequentially("Salt");
    // The page heard the visitor: the code was asked for, and the form says it is busy.
    await expect.poll(held.requested).toBe(true);
    await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
    await expect(from).toHaveValue("Salt");

    await held.release();
    await hydrated(page);
    await settled(page);

    await expect(from).toHaveValue("Salt");
    await expect(from).toBeFocused();
    await expect
      .poll(() =>
        backend.requests.some((request) => request.startsWith("GET /api/v1/geocode?q=Salt")),
      )
      .toBe(true);
    expect(await nodesAreTheSame(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("tapping a load stepper after typing a load applies the tap once", async ({ page }) => {
    const { held, problems } = await openHeld(page);
    await markNodes(page);
    const load = page.getByLabel(/^Load weight/u);

    await load.pressSequentially("5000");
    await page.getByRole("button", { name: "Increase load by 1,000 lb" }).click();
    await expect.poll(held.requested).toBe(true);

    await held.release();
    await hydrated(page);
    await settled(page);

    // 5,000 plus one step. A tap that was lost leaves 5,000; one applied twice makes 7,000.
    await expect(load).toHaveValue("6,000");
    expect(await nodesAreTheSame(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("swapping two typed places swaps them once", async ({ page }) => {
    const { held, problems } = await openHeld(page);
    await markNodes(page);

    await page.getByRole("combobox", { name: FROM }).pressSequentially("Aaa");
    await page.getByRole("combobox", { name: TO }).pressSequentially("Bbb");
    await page.getByRole("button", { name: "Swap origin and destination" }).click();
    await expect.poll(held.requested).toBe(true);

    await held.release();
    await hydrated(page);
    await settled(page);

    // Swapped once. Applied twice they would be back where they started.
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("Bbb");
    await expect(page.getByRole("combobox", { name: TO })).toHaveValue("Aaa");
    expect(await nodesAreTheSame(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("choosing the 10 mile interval is kept, and the plan request uses it", async ({ page }) => {
    const { held, problems } = await openHeld(page);
    await markNodes(page);
    const ten = page.getByRole("radio", { name: "10 mi" });

    await page.getByText("10 mi", { exact: true }).click();
    await expect(ten).toBeChecked();
    await expect.poll(held.requested).toBe(true);

    await held.release();
    await hydrated(page);
    await settled(page);

    await expect(ten).toBeChecked();
    await chooseTrip(page);
    const planned = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().endsWith("/api/v1/plans"),
    );
    await page.getByRole("button", { name: "Plan routes" }).click();
    expect(
      ((await planned).postDataJSON() as { sampling_interval_mi: number }).sampling_interval_mi,
    ).toBe(10);
    expect(problems).toEqual([]);
  });

  test("a digit typed into a date segment is held back and never disagrees with the page", async ({
    page,
  }) => {
    const { held, problems } = await openHeld(page);
    const date = page.getByRole("group", { name: "Date" });
    const segment = date.locator("[contenteditable]").first();
    const before = await segment.innerText();

    await segment.focus();
    await page.keyboard.press("1");
    await expect.poll(held.requested).toBe(true);
    await expect(segment).toHaveText(before);

    await held.release();
    await hydrated(page);
    await settled(page);

    // The digit was held back, not applied late: the departure is the one the clock gave.
    await expect(date).toContainText("10/21/2026");
    await expect(page.locator('input[type="date"]')).toHaveValue("2026-10-21");
    expect(problems).toEqual([]);
  });

  test("Enter in a field changes nothing before hydration, and checks the form once after it", async ({
    page,
  }) => {
    const { held, problems } = await openHeld(page);
    const from = page.getByRole("combobox", { name: FROM });
    const history = await page.evaluate(() => window.history.length);

    await from.pressSequentially("x");
    await from.press("Enter");
    await expect.poll(held.requested).toBe(true);
    expect(new URL(page.url()).search).toBe("");
    expect(await page.evaluate(() => window.history.length)).toBe(history);

    await held.release();
    await hydrated(page);

    await expect(page.getByText(REQUIRED)).toHaveCount(1);
    expect(new URL(page.url()).search).toBe("");
    expect(problems).toEqual([]);
  });

  test("tapping Plan routes changes nothing before hydration, and checks the form once after it", async ({
    page,
  }) => {
    const { held, problems } = await openHeld(page);
    const history = await page.evaluate(() => window.history.length);

    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect.poll(held.requested).toBe(true);
    expect(new URL(page.url()).search).toBe("");
    expect(await page.evaluate(() => window.history.length)).toBe(history);

    await held.release();
    await hydrated(page);

    await expect(page.getByText(REQUIRED)).toHaveCount(1);
    expect(problems).toEqual([]);
  });

  test("a submit made on a shared link before hydration plans the trip once", async ({
    page,
    backend,
  }) => {
    const { held, problems } = await openHeld(page, tripAddress("calm"));
    const address = page.url();

    await page.getByRole("combobox", { name: FROM }).press("Enter");
    await expect.poll(held.requested).toBe(true);
    expect(page.url()).toBe(address);

    await held.release();
    await hydrated(page);

    await expect(page.getByText(/^Take Route [A-C]\.$/u)).toBeVisible();
    expect(
      backend.requests.filter((request) => request.startsWith("POST /api/v1/plans")),
    ).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test("focus stays on the control the visitor focused", async ({ page }) => {
    const { held, problems } = await openHeld(page);
    await markNodes(page);
    const to = page.getByRole("combobox", { name: TO });

    await to.focus();
    await expect.poll(held.requested).toBe(true);
    await held.release();
    await hydrated(page);
    await settled(page);

    await expect(to).toBeFocused();
    expect(await nodesAreTheSame(page)).toBe(true);
    expect(problems).toEqual([]);
  });
});

// D-47: the form is one element in one container on every screen. Before the code arrives the
// visitor marks the field, focuses it and types; when the code has arrived it is the same node, in
// the same chain of parents (nothing was moved into a portal), with the text and the focus intact.
test("the form is not moved or rebuilt when the planner's code takes the page over", async ({
  page,
}) => {
  const { held, problems } = await openHeld(page);
  await markNodes(page);
  const from = page.getByRole("combobox", { name: FROM });

  await from.focus();
  await from.pressSequentially("Salt Lake");
  await expect.poll(held.requested).toBe(true);
  await held.release();
  await hydrated(page);
  await settled(page);

  expect(await nodesAreTheSame(page)).toBe(true);
  await expect(from).toHaveValue("Salt Lake");
  await expect(from).toBeFocused();
  await expect(page.getByRole("region", { name: "Trip planner" })).toHaveAttribute(
    "data-wide",
    "panel",
  );
  expect(problems).toEqual([]);
});

// The page around the planner changes while nobody has touched the planner: a saved theme is applied
// right after hydration, and the theme can change again later (another tab). None of that is an
// input, and none of it may cost the visitor the planner they are looking at. React keeps a
// boundary that waits for its code only until it is updated twice, and then draws it again with
// nothing in it, so the planner is not one: the page draws it as plain HTML that no update reaches.
test("a saved theme, and changes of the theme before the first input, leave the planner as it was", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hc-theme", "dark");
  });
  const { held, problems } = await openHeld(page);
  await markNodes(page);

  await page.evaluate(() => {
    for (const theme of ["light", "dark", "light"]) {
      window.localStorage.setItem("hc-theme", theme);
      window.dispatchEvent(new StorageEvent("storage", { key: "hc-theme" }));
    }
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // Let React draw whatever those changes asked for.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  expect(held.requested()).toBe(false);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Plan routes" })).toBeVisible();
  expect(await nodesAreTheSame(page)).toBe(true);
  expect(problems).toEqual([]);
});

// ADR 0007, N1: a visitor who leaves the page alone never downloads the planner's code.
test("a page nobody touches never asks for the planner's code", async ({ page }) => {
  const { held, problems } = await openHeld(page);

  await page.waitForLoadState("load");
  await page.waitForTimeout(10_000);

  expect(held.requested()).toBe(false);
  await expect(page.getByRole("region", { name: "Trip planner" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Plan routes" })).toBeVisible();
  expect(problems).toEqual([]);
});

// The helper every other spec uses: it must start the download with a real input, not a switch.
test("openPlanner wakes the planner with the pointer, like a visitor", async ({ page }) => {
  await openPlanner(page);

  await expect(page.getByRole("button", { name: "Plan routes" })).toBeEnabled();
});
