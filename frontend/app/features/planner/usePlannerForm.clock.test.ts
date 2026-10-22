import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NO_DEPARTURE, departureOf, type Clock } from "./departure";
import { usePlannerForm } from "./usePlannerForm";

const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };

/** A form that starts on the prerendered page (no clock) and is given one afterwards. */
function setup(defaults: Parameters<typeof usePlannerForm>[0] = {}) {
  return renderHook(({ clock }: { clock: Clock | null }) => usePlannerForm(defaults, clock), {
    initialProps: { clock: null as Clock | null },
  });
}

// The planner is hydrated in place: the form is not thrown away and rebuilt when the browser's clock
// arrives (D-46, D-47), so whatever the visitor did to it meanwhile stays. The departure is the one
// field that has to wait for the clock, and it fills in where it stands.
describe("usePlannerForm: the clock arrives after the page is hydrated", () => {
  it("fills the departure in place when the clock arrives, keeping what was typed meanwhile", () => {
    const view = setup();
    act(() => {
      view.result.current.setOriginText("Salt");
    });
    expect(view.result.current.departure).toEqual(NO_DEPARTURE);

    view.rerender({ clock: CLOCK });

    expect(view.result.current.departure.time?.toString()).toBe("08:00:00");
    expect(view.result.current.origin.text).toBe("Salt");
  });

  it("starts from the departure the link carried when the clock arrives", () => {
    const depart = new Date("2026-10-22T20:15:00Z");
    const view = setup({ depart });

    view.rerender({ clock: CLOCK });

    expect(view.result.current.departure).toEqual(departureOf(depart, CLOCK.timeZone));
  });

  it("does not fill over a departure the visitor has already set", () => {
    const view = setup();
    const chosen = departureOf(new Date("2026-10-25T18:00:00Z"), CLOCK.timeZone);
    act(() => {
      view.result.current.setDeparture(chosen);
    });

    view.rerender({ clock: CLOCK });

    expect(view.result.current.departure).toEqual(chosen);
  });

  it("fills the departure once: a visitor who clears it is not given one again", () => {
    const view = setup();
    view.rerender({ clock: CLOCK });
    act(() => {
      view.result.current.setDeparture(NO_DEPARTURE);
    });

    view.rerender({ clock: { ...CLOCK } });

    expect(view.result.current.departure).toEqual(NO_DEPARTURE);
  });
});
