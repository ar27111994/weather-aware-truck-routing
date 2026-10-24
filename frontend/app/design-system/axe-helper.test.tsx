import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { configureAxe } from "vitest-axe";

import { expectNoAxeViolations, warmUpAxe } from "../../test/axe";

/**
 * Tests of `test/axe.ts`, the helper that every accessibility test scans through (R3-04).
 *
 * axe-core runs one scan at a time, and a scan that starts while another is running is refused:
 * "Axe is already running". A test that overruns its time-out stops waiting, but its scan goes on,
 * so the scans of the tests after it were refused too, and those tests failed for a reason that was
 * not theirs. The helper queues every scan behind the one before it, and a hook after each test
 * waits for a scan that its test left running, so that only the test that overran fails.
 *
 * axe-core is the real one. A scan is made to overrun by a rule of this file: it holds the scan of
 * any markup that has `data-stalls-axe` until the test lets it go, which stands for a slow machine.
 */

/**
 * What a held scan waits for. A hold that is released stays released, so a scan that reaches its
 * check after the release is not held at all.
 */
interface Hold {
  /** Settles once axe-core is inside the check that holds the scan: the scan is under way. */
  readonly reached: Promise<void>;
  /** The check says that it has been reached. */
  readonly reach: () => void;
  /** Settles once the held scans may finish. */
  readonly released: Promise<void>;
  /** Lets every held scan finish. */
  readonly release: () => void;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHold(): Hold {
  const reached = deferred();
  const released = deferred();
  return {
    reached: reached.promise,
    reach: reached.resolve,
    released: released.promise,
    release: released.resolve,
  };
}

/** The hold that the next scan of `data-stalls-axe` markup waits for; a test that holds a scan makes its own. */
let hold = createHold();

configureAxe({
  globalOptions: {
    checks: [
      {
        id: "holds-until-released",
        evaluate() {
          const finish = this.async();
          hold.reach();
          void hold.released.then(() => {
            finish(true);
          });
        },
        metadata: {
          impact: "minor",
          messages: { pass: "The scan was let go.", fail: "The scan was not let go." },
        },
      },
    ],
    rules: [
      {
        id: "holds-scan",
        selector: "[data-stalls-axe]",
        excludeHidden: false,
        any: ["holds-until-released"],
        metadata: {
          description: "Holds a scan until a test lets it go.",
          help: "Holds a scan until a test lets it go.",
          helpUrl: "",
        },
      },
    ],
  },
});

type Outcome =
  | { readonly status: "pending" }
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly reason: unknown };

interface Observed {
  /** What the scan has come to so far. */
  readonly outcome: () => Outcome;
  /** Settles once the scan has, whichever way. */
  readonly settled: Promise<void>;
}

/** Watches a scan without waiting for it, as a test that has stopped waiting would. */
function observe(scan: Promise<void>): Observed {
  let outcome: Outcome = { status: "pending" };
  const settled = scan.then(
    () => {
      outcome = { status: "passed" };
    },
    (reason: unknown) => {
      outcome = { status: "failed", reason };
    },
  );
  return { outcome: () => outcome, settled };
}

/** A few turns of the event loop: long enough for a scan that is refused to say so. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

/** Markup that axe-core holds until the current hold is released. */
function heldPage(): HTMLElement {
  return render(<div data-stalls-axe="" />).container;
}

/** Markup that axe-core has nothing to say about. */
function cleanPage(): HTMLElement {
  return render(<p>Nothing for axe-core to object to.</p>).container;
}

// The first scan builds axe-core's rule set, which costs a second or more: not the first test's.
beforeAll(warmUpAxe);

describe("expectNoAxeViolations", () => {
  it("holds a scan back while another is running, then runs it", async () => {
    hold = createHold();
    try {
      const running = observe(expectNoAxeViolations(heldPage()));
      await hold.reached;

      const next = observe(expectNoAxeViolations(cleanPage()));
      await pause();

      // Refused ("Axe is already running"), the scan would be settled here.
      expect(next.outcome()).toEqual({ status: "pending" });
      expect(running.outcome()).toEqual({ status: "pending" });
      hold.release();
      await Promise.all([running.settled, next.settled]);
      expect(running.outcome()).toEqual({ status: "passed" });
      expect(next.outcome()).toEqual({ status: "passed" });
    } finally {
      hold.release();
    }
  });

  it("keeps scanning after a scan that found a violation", async () => {
    // The scan that found it reports it to its own caller, and the scan after it still runs.
    await expect(
      expectNoAxeViolations(render(<button type="button" />).container),
    ).rejects.toMatchObject({ actual: [expect.stringContaining("button-name:")] });

    await expectNoAxeViolations(cleanPage());
  });
});

// Two tests that depend on each other: the second is what the hook after the first protects.
describe("a scan that is still running when its test ends", () => {
  let left: Observed;

  it("starts a scan and ends without waiting for it", () => {
    hold = createHold();
    const own = hold;
    // A slow scan, not a stuck one: it is let go while the next test is about to start.
    setTimeout(() => {
      own.release();
    }, 100);

    left = observe(expectNoAxeViolations(heldPage()));
  });

  it("starts only after that scan is done, and is not refused", async () => {
    expect(left.outcome()).toEqual({ status: "passed" });

    await expectNoAxeViolations(cleanPage());
  });
});
