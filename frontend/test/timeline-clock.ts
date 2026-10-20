import type { TimelineClock } from "../app/design-system/components/Slider/timeline";

/** Tue 2026-10-20 14:00 in Denver (MDT, UTC-6) is 20:00 UTC. */
export const DEPARTURE = Date.UTC(2026, 9, 20, 20, 0, 0);

/** The clock the timeline tests share: that departure, written in Denver and en-US. */
export const DENVER = {
  departure: DEPARTURE,
  timeZone: "America/Denver",
  locale: "en-US",
} as const satisfies TimelineClock;
