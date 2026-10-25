import { configureAxe } from "vitest-axe";
import { afterEach, expect, vi } from "vitest";

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
 * Settles when every scan started so far has settled, whether it passed or failed. axe-core runs one
 * scan at a time and refuses a scan that starts while another is running ("Axe is already running").
 * A test that overruns its time-out stops waiting, but its scan goes on, so the scans of the tests
 * after it were refused too, and those tests failed for a reason that was not theirs (R3-04). Every
 * scan therefore waits here for the one before it.
 */
let lastScan: Promise<void> = Promise.resolve();

// A scan that its test left running is waited for in the hook of that test, so that the next test
// starts with axe-core idle and only the test that overran fails. Every file that scans imports
// this module, so the hook cannot be left out of one.
afterEach(async () => {
  await lastScan;
});

function settle(): void {
  return undefined;
}

async function scan(container: Element): Promise<void> {
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
 * Asserts that axe-core finds no violations in the rendered markup. On failure the assertion
 * prints each violated rule with the offending selectors instead of a bare boolean. A scan waits
 * for the one before it to finish, whichever way that one ended.
 *
 * @param container - The element to scan, usually the `container` returned by `render`.
 */
export function expectNoAxeViolations(container: Element): Promise<void> {
  const turn = lastScan.then(() => scan(container));
  // The next scan goes on after a scan that failed; the failure itself goes to this scan's caller.
  lastScan = turn.then(settle, settle);
  return turn;
}

/**
 * Runs axe once over an empty element. axe-core builds its rule set on its first run, which costs a
 * second or more on a quiet machine and several times that under load. Call this from `beforeAll` in
 * a file that scans many things, so that cost is charged to the hook and not to whichever test scans
 * first, which would time out on it. The queue above keeps an overrun from reaching the tests after
 * that one; this keeps it from happening to the first.
 */
export async function warmUpAxe(): Promise<void> {
  const probe = document.body.appendChild(document.createElement("div"));
  try {
    await expectNoAxeViolations(probe);
  } finally {
    probe.remove();
  }
}
