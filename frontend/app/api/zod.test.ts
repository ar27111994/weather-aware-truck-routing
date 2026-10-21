import { describe, expect, it, vi } from "vitest";

/**
 * Production's `script-src` has no `'unsafe-eval'` (vercel.json). Zod 4 compiles a fast parser
 * for each object schema with `new Function` when the page allows it, and finds out by calling
 * `new Function("")` once, inside a try/catch, when the first object schema is created. Under the
 * policy the browser blocks that call and reports a `securitypolicyviolation` (blocked `eval`) even
 * though the error is caught, so every page that validates API data would report one.
 *
 * Nothing here imports Zod or the contract at the top: the modules are loaded inside each test,
 * after the Function constructor is watched, so the first schema they create is seen.
 */

/** Records the arguments of every call of the global Function constructor, `new` or not. */
function watchFunctionConstructor(): string[][] {
  const calls: string[][] = [];
  const RealFunction = globalThis.Function;
  vi.stubGlobal(
    "Function",
    new Proxy(RealFunction, {
      construct(target, args: string[]) {
        calls.push(args);
        return Reflect.construct(target, args);
      },
      apply(target, thisArg: unknown, args: string[]) {
        calls.push(args);
        return Reflect.apply(target, thisArg, args);
      },
    }),
  );
  return calls;
}

describe("the app's Zod (strict CSP)", () => {
  it("creates the contract's schemas without probing whether the page may compile code", async () => {
    vi.resetModules();
    const calls = watchFunctionConstructor();

    const contract = await import("./contract");

    expect(contract.planLocationSchema).toBeDefined();
    expect(calls).toEqual([]);
  });

  it("parses an object without compiling a parser for it", async () => {
    vi.resetModules();
    const { planLocationSchema } = await import("./contract");
    const calls = watchFunctionConstructor();

    const parsed = planLocationSchema.parse({ lat: 40.76, lon: -111.89, label: "Salt Lake City" });

    expect(parsed).toEqual({ lat: 40.76, lon: -111.89, label: "Salt Lake City" });
    expect(calls).toEqual([]);
  });

  it("loads the mock trips, the other module with schemas, without compiling either", async () => {
    vi.resetModules();
    const calls = watchFunctionConstructor();

    const mocks = await import("./mocks");

    expect(mocks.buildPlan).toBeTypeOf("function");
    expect(calls).toEqual([]);
  });
});
