import { render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FAKE_TIMER_POLLS,
  FAKE_TIMER_POLL_MS,
  findUnderFakeTimers,
  installFakeTimers,
} from "../../test/fake-timers";

/**
 * Tests of `findUnderFakeTimers` in `test/fake-timers.ts`, the wait that a test uses while
 * `installFakeTimers()` is on (R4F-VH).
 *
 * Testing Library's `findBy*` and `waitFor` cannot be used there. Under a fake clock they loop until
 * their own timeout timer fires on that clock. When Vitest fails the test at its timeout (a loaded
 * host does it), `vi.useRealTimers()` runs, the next test installs a new clock, and the timer of the
 * abandoned loop sits on the old one: the loop polls for ever, never lets the event loop turn, and
 * the worker never ends. The helper counts its runs instead, so it ends whatever happens to the
 * clock. A stand-in query that counts and throws plays the part of `screen.getByRole`, so that
 * nothing but the helper is under test.
 */

afterEach(() => {
  vi.useRealTimers();
});

/** Shows a button once `delayMs` of the clock have passed, as a debounced search shows its hits. */
function ShowsLater({ delayMs }: { readonly delayMs: number }): ReactElement {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setShown(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs]);
  return shown ? <button type="button">Later</button> : <p>Waiting</p>;
}

/**
 * A query that throws until its `succeedsOnRun`-th run and counts its runs. `Infinity` makes one
 * that never finds anything.
 */
function countedQuery(succeedsOnRun: number): {
  readonly query: () => string;
  readonly runs: () => number;
} {
  let runs = 0;
  return {
    query: () => {
      runs += 1;
      if (runs < succeedsOnRun) throw new Error(`not yet (run ${String(runs)})`);
      return `found on run ${String(runs)}`;
    },
    runs: () => runs,
  };
}

describe("findUnderFakeTimers", () => {
  it("finds what a timer shows after a pause, on the fake clock", async () => {
    installFakeTimers();
    render(<ShowsLater delayMs={120} />);

    const button = await findUnderFakeTimers(() => screen.getByRole("button", { name: "Later" }));

    expect(button).toBeInTheDocument();
  });

  it("answers at once, with no time spent, when the query finds its element already", async () => {
    installFakeTimers();
    render(<button type="button">Now</button>);
    const start = Date.now();

    const button = await findUnderFakeTimers(() => screen.getByRole("button", { name: "Now" }));

    expect(button).toBeInTheDocument();
    expect(Date.now()).toBe(start);
  });

  it("runs the query again after each pause and returns what it finds", async () => {
    installFakeTimers();
    const { query, runs } = countedQuery(3);

    await expect(findUnderFakeTimers(query)).resolves.toBe("found on run 3");

    expect(runs()).toBe(3);
  });

  it("lets the same time pass on the fake clock between two runs", async () => {
    installFakeTimers();
    const { query } = countedQuery(Number.POSITIVE_INFINITY);
    const start = Date.now();

    await expect(findUnderFakeTimers(query, { polls: 5 })).rejects.toThrow("not yet");

    expect(Date.now() - start).toBe(4 * FAKE_TIMER_POLL_MS);
  });

  it("throws the very error that its last run threw, after the runs it was allowed", async () => {
    installFakeTimers();
    const failures: Error[] = [];
    const query = (): never => {
      const failure = new Error(`not yet (run ${String(failures.length + 1)})`);
      failures.push(failure);
      throw failure;
    };

    const thrown = await findUnderFakeTimers(query, { polls: 5 }).catch((error: unknown) => error);

    expect(failures).toHaveLength(5);
    expect(thrown).toBe(failures[4]);
  });

  it("takes a find on its last run and refuses one that comes a run later", async () => {
    installFakeTimers();
    const onLast = countedQuery(4);
    const oneLate = countedQuery(5);

    await expect(findUnderFakeTimers(onLast.query, { polls: 4 })).resolves.toBe("found on run 4");
    await expect(findUnderFakeTimers(oneLate.query, { polls: 4 })).rejects.toThrow("(run 4)");

    expect(onLast.runs()).toBe(4);
    expect(oneLate.runs()).toBe(4);
  });

  it("gives up after FAKE_TIMER_POLLS runs when it is not told how many", async () => {
    installFakeTimers();
    const { query, runs } = countedQuery(Number.POSITIVE_INFINITY);

    await expect(findUnderFakeTimers(query)).rejects.toThrow(`(run ${String(FAKE_TIMER_POLLS)})`);

    expect(runs()).toBe(FAKE_TIMER_POLLS);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s runs, because a wait that cannot end is what it is there to prevent",
    async (polls) => {
      installFakeTimers();
      const { query, runs } = countedQuery(1);

      await expect(findUnderFakeTimers(query, { polls })).rejects.toThrow(RangeError);

      expect(runs()).toBe(0);
    },
  );

  it("ends a wait that its test left behind, although the next test installed another clock", async () => {
    // The first test: its query can never succeed. Vitest fails a test at its timeout and goes on
    // without stopping the body, so the wait carries on after the test.
    installFakeTimers();
    const { query, runs } = countedQuery(Number.POSITIVE_INFINITY);
    const abandoned = findUnderFakeTimers(query, { polls: 25 }).then(
      () => "found",
      (error: unknown) => error,
    );

    // The second test: `afterEach` puts real timers back and the test installs a clock of its own.
    vi.useRealTimers();
    installFakeTimers();

    // The abandoned wait ends by itself, with what its query last said, and not after more runs
    // than it was allowed. With Testing Library's `waitFor` it would run until the worker is killed.
    const outcome = await abandoned;
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome instanceof Error && outcome.message).toBe("not yet (run 25)");
    expect(runs()).toBe(25);
  });

  it("fails on the first pause when no fake clock is installed, and does not wait in real time", async () => {
    const { query, runs } = countedQuery(Number.POSITIVE_INFINITY);

    await expect(findUnderFakeTimers(query, { polls: 5 })).rejects.toThrow(/not mocked/u);

    expect(runs()).toBe(1);
  });
});

// Two tests that belong together: the second one looks at what the first left behind. Vitest runs
// the tests of a file in order, and the second says so when the first did not run.
describe("a wait that its test left behind", () => {
  let runs = 0;

  it("starts a wait that never succeeds and leaves it running when the test ends", async () => {
    installFakeTimers();
    const query = (): never => {
      runs += 1;
      throw new Error("not yet");
    };

    // This is what a test that Vitest fails at its timeout leaves: a wait that nobody awaits any
    // more, in the middle of its runs.
    findUnderFakeTimers(query, { polls: 1_000 }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10 * FAKE_TIMER_POLL_MS);
  });

  it("is over with that test: it makes no more runs on the clock of the next test", async () => {
    installFakeTimers();
    const started = runs;
    expect(started, "the test before this one starts the wait").toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(40 * FAKE_TIMER_POLL_MS);

    expect(runs).toBe(started);
  });
});
