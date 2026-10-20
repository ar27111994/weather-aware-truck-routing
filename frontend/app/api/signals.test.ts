// @vitest-environment node
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { linkSignals } from "./signals";

let restoreNativeAny: (() => void) | undefined;

/** Removes the platform's `AbortSignal.any` (Chrome < 116, Firefox < 124, Safari < 17.4). */
function hideNativeAny(): void {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Reflect.deleteProperty(AbortSignal, "any");
  restoreNativeAny = () => {
    if (original) Object.defineProperty(AbortSignal, "any", original);
  };
}

afterEach(() => {
  restoreNativeAny?.();
  restoreNativeAny = undefined;
});

describe.each([
  { name: "a platform with AbortSignal.any", native: true },
  { name: "a platform without AbortSignal.any", native: false },
])("linkSignals on $name", ({ native }) => {
  function link(...signals: AbortSignal[]): ReturnType<typeof linkSignals> {
    if (!native) hideNativeAny();
    return linkSignals(signals);
  }

  it("stays pending while no input has aborted", () => {
    const { signal } = link(new AbortController().signal, new AbortController().signal);
    expect(signal.aborted).toBe(false);
  });

  it("aborts with the reason of whichever input aborts first", () => {
    const first = new AbortController();
    const second = new AbortController();
    const { signal } = link(first.signal, second.signal);
    const reason = new Error("caller gave up");

    second.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    first.abort(new Error("too late to matter"));
    expect(signal.reason).toBe(reason);
  });

  it("notifies the listeners of the linked signal", () => {
    const input = new AbortController();
    const { signal } = link(input.signal);
    const onAbort = vi.fn();
    signal.addEventListener("abort", onAbort);

    input.abort();

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("is already aborted, with that reason, when an input already is", () => {
    const aborted = new AbortController();
    const reason = new Error("already cancelled");
    aborted.abort(reason);

    const { signal } = link(new AbortController().signal, aborted.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("can be disposed more than once without error", () => {
    const { dispose } = link(new AbortController().signal);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});

describe("the native path", () => {
  it("delegates to AbortSignal.any", () => {
    const spy = vi.spyOn(AbortSignal, "any");
    const inputs = [new AbortController().signal, new AbortController().signal];

    linkSignals(inputs);

    expect(spy).toHaveBeenCalledExactlyOnceWith(inputs);
  });
});

describe("the fallback path", () => {
  it("stops following the inputs once disposed", () => {
    hideNativeAny();
    const input = new AbortController();
    const { signal, dispose } = linkSignals([input.signal]);

    dispose();
    input.abort();

    expect(signal.aborted).toBe(false);
  });

  it("holds one listener per input while linked and none after dispose", () => {
    hideNativeAny();
    const longLived = new AbortController();
    const other = new AbortController();

    const { dispose } = linkSignals([longLived.signal, other.signal]);
    expect(getEventListeners(longLived.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(other.signal, "abort")).toHaveLength(1);

    dispose();
    expect(getEventListeners(longLived.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(other.signal, "abort")).toHaveLength(0);
  });

  it("releases the other inputs as soon as one aborts", () => {
    hideNativeAny();
    const first = new AbortController();
    const second = new AbortController();
    linkSignals([first.signal, second.signal]);

    first.abort();

    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
  });
});
