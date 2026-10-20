/**
 * Links abort signals so one request can be cancelled by the caller or by its timeout.
 *
 * `AbortSignal.any` does this natively, but it only exists from Chrome 116, Firefox 124 and
 * Safari 17.4, while Vite 7 builds for Chrome 107, Firefox 104 and Safari 16 by default. Calling
 * it unguarded would make every request that carries a caller signal throw a `TypeError` on those
 * browsers, so {@link linkSignals} falls back to listening on the inputs.
 */

/** A signal that aborts when any of its inputs does, plus the means to release it. */
export interface LinkedSignal {
  readonly signal: AbortSignal;
  /**
   * Stops following the inputs; call it once the work the signal guards has finished. The fallback
   * leaves a listener on every input until then, so a signal shared by many calls would otherwise
   * collect one per call. A no-op where the platform links natively.
   */
  readonly dispose: () => void;
}

/** The part of `AbortSignal` that is missing from browsers released before 2023-2024. */
interface NativeLinking {
  readonly any?: (signals: AbortSignal[]) => AbortSignal;
}

const noop = (): void => undefined;

/**
 * A signal that aborts, with the same reason, as soon as any of `signals` does (immediately when
 * one already has).
 */
export function linkSignals(signals: readonly AbortSignal[]): LinkedSignal {
  const platform: NativeLinking = AbortSignal;
  if (platform.any) return { signal: platform.any([...signals]), dispose: noop };

  const controller = new AbortController();
  const alreadyAborted = signals.find((candidate) => candidate.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, dispose: noop };
  }

  const detachers: (() => void)[] = [];
  const dispose = (): void => {
    for (const detach of detachers) detach();
  };
  for (const source of signals) {
    const onAbort = (): void => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    detachers.push(() => {
      source.removeEventListener("abort", onAbort);
    });
  }
  return { signal: controller.signal, dispose };
}
