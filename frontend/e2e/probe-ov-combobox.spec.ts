import AxeBuilder from "@axe-core/playwright";
import { test } from "@playwright/test";

import { openDesign, settleAnimations } from "./support/design";

/**
 * THROWAWAY PROBE (R4F-OV, never merged). Why does axe report label-content-name-mismatch on the
 * options of the open combo box list in four projects and not on pixel-7? It records what the page
 * and axe see: the geometry and styles of the list, and every result of the rule with its check data.
 */
test("PROBE combo box list and label-content-name-mismatch", async ({ page }, testInfo) => {
  await openDesign(page, { sections: ["ComboBox"] });
  const input = page
    .locator('[data-demo="ComboBox"] section')
    .filter({ has: page.locator("h3").getByText("Recent places (opens on focus)", { exact: true }) })
    .getByRole("combobox", { name: "Origin" });
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.getByRole("listbox").waitFor();
  await settleAnimations(page);

  const info = await page.evaluate(() => {
    const rect = (element: Element): number[] => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value));
    };
    const popover = document.querySelector('[data-trigger="ComboBox"]');
    const list = document.querySelector('[role="listbox"]');
    return {
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      visualViewport: [visualViewport?.width, visualViewport?.height, visualViewport?.offsetTop],
      scroll: [scrollX, scrollY],
      popover:
        popover === null
          ? null
          : {
              rect: rect(popover),
              style: (({ overflow, opacity, maxHeight, transform, position }) => ({
                overflow,
                opacity,
                maxHeight,
                transform,
                position,
              }))(getComputedStyle(popover)),
              attributes: popover.getAttributeNames().join(","),
            },
      list: list === null ? null : { rect: rect(list), overflow: getComputedStyle(list).overflowY },
      options: [...document.querySelectorAll('[role="option"]')].map((option) => ({
        text: option.textContent,
        rect: rect(option),
        labelledby: option.getAttribute("aria-labelledby"),
        describedby: option.getAttribute("aria-describedby"),
        opacity: getComputedStyle(option).opacity,
      })),
      fonts: [...document.fonts].map((font) => `${font.family}:${font.status}`).slice(0, 6),
    };
  });
  console.log("PROBE-INFO", testInfo.project.name, JSON.stringify(info));

  const results = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
  const nodes = (items: typeof results.violations): unknown =>
    items.map((item) =>
      item.nodes.map((node) => ({
        target: node.target,
        data: node.any.map((check) => check.data),
        message: node.any.map((check) => check.message),
      })),
    );
  console.log(
    "PROBE-AXE",
    testInfo.project.name,
    JSON.stringify({
      violations: nodes(results.violations),
      incomplete: nodes(results.incomplete),
      passes: results.passes.map((pass) => pass.nodes.map((node) => node.target)),
      inapplicable: results.inapplicable.map((item) => item.id),
    }),
  );
});
