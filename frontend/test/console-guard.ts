import { afterEach, beforeEach, vi } from "vitest";

const unexpected: string[] = [];
const allowed: RegExp[] = [];

/**
 * Fails every test that logs an error or a warning it did not say it expects, so React, React
 * Router and the code under test cannot print a problem that nobody reads (R1-42). Called once from
 * `vitest.setup.ts`. A test that expects output either mocks `console.error` or `console.warn`
 * itself, or names the message with {@link allowConsole}.
 */
export function installConsoleGuard(): void {
  beforeEach(() => {
    unexpected.length = 0;
    allowed.length = 0;
    for (const level of ["error", "warn"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (!allowed.some((pattern) => pattern.test(text))) {
          unexpected.push(`console.${level}: ${text}`);
        }
      });
    }
  });

  afterEach(() => {
    const logs = unexpected.splice(0);
    if (logs.length > 0) {
      throw new Error(
        `Unexpected console output; fix its cause, or say it is expected with allowConsole:\n${logs.join("\n")}`,
      );
    }
  });
}

/**
 * Says that the current test expects a console message matching `pattern`; the message is swallowed
 * and every other one still fails the test. Give the reason where you call it.
 */
export function allowConsole(pattern: RegExp): void {
  allowed.push(pattern);
}
