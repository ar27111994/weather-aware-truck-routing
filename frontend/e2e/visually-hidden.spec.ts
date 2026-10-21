import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { openDesign } from "./support/design";

/**
 * VisuallyHidden (R1-20). The unit tests prove that it adds no inline style (a strict CSP would
 * block one); what it looks like is in the stylesheet, which jsdom does not load, so the class
 * name a unit test could read passes with the clip rule deleted. Here the browser computes it.
 * The tests load the VisuallyHidden section only (D-35).
 */

/** Opens the section of `/design` that these tests are about. */
async function openSection(page: Page): Promise<void> {
  await openDesign(page, { sections: ["VisuallyHidden"] });
}

function specimen(page: Page, state: string): Locator {
  return page.locator(`[data-demo="VisuallyHidden"] [data-state="${state}"]`);
}

/** The properties of the clip recipe, as the browser computes them. */
function clipOf(element: Locator): Promise<Record<string, string>> {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      position: style.position,
      width: style.width,
      height: style.height,
      overflow: style.overflow,
      clipPath: style.clipPath,
      whiteSpace: style.whiteSpace,
    };
  });
}

const CLIPPED = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

test.describe("VisuallyHidden", () => {
  test("clips what it hides to a point, and the words still name the button", async ({ page }) => {
    await openSection(page);
    const button = specimen(page, "inside-a-button").getByRole("button", {
      name: "Copy link to this plan",
    });

    await expect(button).toBeVisible();

    expect(await clipOf(button.locator("span"))).toEqual(CLIPPED);
  });

  test("a focusable instance shows itself while it has focus, and hides again after", async ({
    page,
  }) => {
    await openSection(page);
    const link = specimen(page, "focusable").getByRole("link", {
      name: "Skip to the component list",
    });
    const wrapper = link.locator("xpath=..");
    expect(await clipOf(wrapper)).toEqual(CLIPPED);

    await link.focus();

    const shown = await clipOf(wrapper);
    expect(shown["clipPath"]).toBe("none");
    expect(shown["width"]).not.toBe("1px");
    expect(shown["position"]).not.toBe("absolute");

    await link.blur();

    expect(await clipOf(wrapper)).toEqual(CLIPPED);
  });
});
