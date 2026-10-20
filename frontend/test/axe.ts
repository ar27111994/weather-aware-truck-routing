import { configureAxe } from "vitest-axe";
import { expect, vi } from "vitest";

const axe = configureAxe({
  rules: {
    // jsdom has no layout engine, so contrast cannot be computed here. Contrast is proven by the
    // design seat's tool-computed report (376 pairs) and by the Playwright axe run in a browser.
    "color-contrast": { enabled: false },
    // Page-level rule: a component under test is a fragment, not a whole page.
    region: { enabled: false },
  },
});

/**
 * Asserts that axe-core finds no violations in the rendered markup. On failure the assertion
 * prints each violated rule with the offending selectors instead of a bare boolean.
 *
 * @param container - The element to scan, usually the `container` returned by `render`.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  // axe probes canvas support; jsdom answers with a "not implemented" console error. Say "no
  // canvas" quietly instead (the mock is restored after the test by `restoreMocks`).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  const results = await axe(container);
  const readable = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} -> ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`,
  );
  expect(readable).toEqual([]);
}

/**
 * Runs axe once over an empty element. axe-core builds its rule set on its first run, which costs a
 * second or more on a quiet machine and several times that under load. Call this from `beforeAll` in
 * a file that scans many things, so that cost is charged to the hook and not to whichever test scans
 * first: that test then timed out, and its scan, still running, made every later test fail with
 * "Axe is already running".
 */
export async function warmUpAxe(): Promise<void> {
  const probe = document.body.appendChild(document.createElement("div"));
  try {
    await expectNoAxeViolations(probe);
  } finally {
    probe.remove();
  }
}
