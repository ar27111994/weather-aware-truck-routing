import { resolve } from "node:path";

import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

/**
 * Planted-file tests of the `no-restricted-syntax` entries in `eslint.config.js` that keep Testing
 * Library's `findBy*` and `waitFor` out of a test that runs on a fake clock (R4F-VH).
 *
 * Each case is a few lines of test code that ESLint reads with the project's own configuration, as
 * if they were `app/planted.test.tsx`. The cases that must be reported have a twin that must not
 * be: a rule that reports everything, or nothing, passes half of the pairs. The last cases check
 * that the older entries of the same rule are still there, because a second `no-restricted-syntax`
 * block for these files would replace them silently.
 */

// The project's configuration is type-aware, and planted text is not part of the TypeScript
// project, so type information goes off, as the configuration does for its own `.js` files.
const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, "../.."),
  overrideConfig: tseslint.configs.disableTypeChecked,
});

// Reading the project's configuration imports TypeScript and four plugins, which takes seconds and
// much longer on a loaded machine. It is done once, when the file is imported, so that the first
// test does not carry it against the time limit of a test.
await eslint.calculateConfigForFile("app/planted.test.tsx");

/** The messages of `no-restricted-syntax` for `code`, read as the test file `app/planted.test.tsx`. */
async function restricted(code: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath: "app/planted.test.tsx" });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

const WAIT_MESSAGE = /findUnderFakeTimers/u;

describe("the waits that a test on a fake clock must not use", () => {
  it.each([
    [
      "a findBy in a test that installs the fake clock",
      `it("x", async () => {
        installFakeTimers();
        await screen.findByRole("option");
      });`,
      1,
    ],
    [
      "a waitFor in a test that installs the fake clock",
      `it("x", async () => {
        installFakeTimers();
        await waitFor(() => {
          expect(1).toBe(1);
        });
      });`,
      1,
    ],
    [
      "every Testing Library wait, whatever it hangs on",
      `it("x", async () => {
        installFakeTimers();
        const { findByLabelText } = render(<p />);
        await within(list).findAllByText("a");
        await waitForElementToBeRemoved(element);
        await findByLabelText("b");
      });`,
      3,
    ],
    [
      "a wait inside the beforeEach that installs the clock",
      `beforeEach(async () => {
        installFakeTimers();
        await screen.findByRole("option");
      });`,
      1,
    ],
    [
      "a wait in a describe whose beforeEach installs the clock",
      `describe("x", () => {
        beforeEach(() => {
          installFakeTimers();
        });
        it("y", async () => {
          await waitFor(() => {
            expect(1).toBe(1);
          });
        });
      });`,
      1,
    ],
    [
      "a wait in a describe inside one whose beforeEach installs the clock",
      `describe("outer", () => {
        beforeEach(() => {
          installFakeTimers();
        });
        describe("inner", () => {
          it("y", async () => {
            await screen.findByRole("option");
          });
        });
      });`,
      1,
    ],
    [
      "a wait after a beforeEach at the top of the file that installs the clock",
      `beforeEach(() => {
        installFakeTimers();
      });
      it("y", async () => {
        await screen.findAllByRole("option");
      });`,
      1,
    ],
    [
      "the waits of a describe and of an inner describe that has a beforeEach of its own",
      `describe("outer", () => {
        beforeEach(() => {
          installFakeTimers();
        });
        it("a", async () => {
          await screen.findByRole("option");
        });
        describe("inner", () => {
          beforeEach(() => {
            vi.restoreAllMocks();
          });
          it("b", async () => {
            await screen.findByRole("option");
          });
        });
      });`,
      2,
    ],
  ])("reports %s", async (_name, code, count) => {
    const messages = await restricted(code);

    expect(messages).toHaveLength(count);
    for (const message of messages) expect(message).toMatch(WAIT_MESSAGE);
  });

  it.each([
    [
      "the bounded wait in a test that installs the clock",
      `it("x", async () => {
        installFakeTimers();
        await findUnderFakeTimers(() => screen.getByRole("option"));
      });`,
    ],
    [
      "a test on real timers next to one that installs the clock",
      `it("fake", async () => {
        installFakeTimers();
        await findUnderFakeTimers(() => screen.getByRole("option"));
      });
      it("real", async () => {
        await screen.findByRole("option");
        await waitFor(() => {
          expect(1).toBe(1);
        });
      });`,
    ],
    [
      "a file that never installs a fake clock",
      `it("x", async () => {
        await screen.findByRole("option");
      });`,
    ],
    [
      "a test on real timers next to a describe that installs the clock in its own beforeEach",
      `describe("outer", () => {
        describe("fake", () => {
          beforeEach(() => {
            installFakeTimers();
          });
          it("a", async () => {
            await findUnderFakeTimers(() => screen.getByRole("option"));
          });
        });
        it("real", async () => {
          await screen.findByRole("option");
        });
      });`,
    ],
  ])("lets through %s", async (_name, code) => {
    expect(await restricted(code)).toEqual([]);
  });

  it("keeps the older entries of the rule: no copy of the jest stub, no local Controlled", async () => {
    const messages = await restricted(`
      vi.stubGlobal("jest", {});
      function Controlled() {
        return null;
      }
    `);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/installFakeTimers\(\) from test\/fake-timers\.ts/u);
    expect(messages[1]).toMatch(/Import Controlled from test\/controlled\.tsx/u);
  });
});
