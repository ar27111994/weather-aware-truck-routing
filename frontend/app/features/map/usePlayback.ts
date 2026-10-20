/**
 * Forecast playback (DESIGN.md section 10, slider timeline variant): while the store says
 * `playing`, the frame advances one hour every 250 ms (`--motion-duration-frame`), timed by
 * `requestAnimationFrame` so a busy tab never queues up frames, and playback stops at +48 h.
 * Nothing starts it but the Play button: there is no autoplay, with or without reduced motion.
 */
import { useEffect } from "react";

import { HEATMAP_FRAME_COUNT } from "../../api/contract";
import { tripStore, usePlaying } from "../../state/trip-store";
import type { TripStore } from "../../state/trip-store";

/** Time each frame stays on screen while playing, in ms. */
export const FRAME_MS = 250;

/** The last frame (+48 h). */
export const LAST_FRAME = HEATMAP_FRAME_COUNT - 1;

/** The animation clock, injectable so tests drive time. */
export interface FrameClock {
  readonly request: (callback: (now: number) => void) => number;
  readonly cancel: (handle: number) => void;
}

const BROWSER_CLOCK: FrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => {
    cancelAnimationFrame(handle);
  },
};

/** Advances the store's frame while it is playing. */
export function usePlayback(store: TripStore = tripStore, clock: FrameClock = BROWSER_CLOCK): void {
  const playing = usePlaying(store);
  useEffect(() => {
    if (!playing) return undefined;
    let shown: number | undefined;
    let handle = 0;
    const tick = (now: number): void => {
      shown ??= now;
      if (now - shown >= FRAME_MS) {
        shown = now;
        if (store.getState().sliderFrame >= LAST_FRAME) {
          store.actions.pause();
          return;
        }
        store.actions.stepFrame(1);
      }
      handle = clock.request(tick);
    };
    handle = clock.request(tick);
    return () => {
      clock.cancel(handle);
    };
  }, [playing, store, clock]);
}
