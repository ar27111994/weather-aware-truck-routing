import AxeBuilder from "@axe-core/playwright";
import { test } from "@playwright/test";

import { openDesign, settleAnimations } from "./support/design";

/**
 * THROWAWAY PROBE 2 (R4F-OV, never merged). The combo box list had opacity 0 on pixel-7 after
 * settleAnimations. What sets it, and when does it become 1?
 */
test("PROBE combo box list opacity", async ({ page }, testInfo) => {
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

  const samples = await page.evaluate(async () => {
    const out: string[] = [];
    const started = performance.now();
    for (let index = 0; index < 12; index += 1) {
      const all = [...document.querySelectorAll('[data-trigger="ComboBox"]')];
      out.push(
        JSON.stringify({
          t: Math.round(performance.now() - started),
          count: all.length,
          opacity: all.map((element) => getComputedStyle(element).opacity),
          style: all.map((element) => element.getAttribute("style")),
          attrs: all.map((element) => element.getAttributeNames().join(",")),
          transition: all.map((element) => getComputedStyle(element).transitionProperty),
          animationName: all.map((element) => getComputedStyle(element).animationName),
          animations: document
            .getAnimations()
            .map((animation) => `${animation.constructor.name}:${animation.playState}`),
          focused: document.activeElement?.tagName,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return out;
  });
  for (const line of samples) {
    console.log("PROBE-OPACITY", testInfo.project.name, line);
  }
  const results = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
  console.log(
    "PROBE-AXE-LATE",
    testInfo.project.name,
    JSON.stringify({
      violations: results.violations.length,
      nodes: results.violations.map((item) => item.nodes.length),
      inapplicable: results.inapplicable.length,
    }),
  );
});
