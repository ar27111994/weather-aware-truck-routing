import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DENVER, SLC } from "../../../test/plans";
import { NO_DEPARTURE, departureOf, type Clock } from "./departure";
import type { TripUrlState } from "./trip-url";
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

/** A form drawn for an address with no trip in it, which then learns the address with the clock. */
function setupAddressArrival() {
  return renderHook(
    ({ defaults, clock }: { defaults: TripUrlState; clock: Clock | null }) =>
      usePlannerForm(defaults, clock),
    { initialProps: { defaults: {}, clock: null as Clock | null } },
  );
}

const LINK_DEPARTURE = new Date("2026-10-22T20:15:00Z");

const LINK: TripUrlState = {
  origin: SLC,
  destination: DENVER,
  depart: LINK_DEPARTURE,
  load: 38_000,
  interval: 50,
  scenario: "calm",
};

// The page is drawn without the address (the prerendered page has none) and hydrated in place, so
// the address reaches the form in the same render as the clock: the form fills where it stands
// instead of being started over, and whatever the visitor set meanwhile stays.
describe("usePlannerForm: the address arrives after the page is hydrated", () => {
  it("fills every field the link carried when the address arrives with the clock", () => {
    const view = setupAddressArrival();
    expect(view.result.current.origin.text).toBe("");
    expect(view.result.current.load).toBeNaN();

    view.rerender({ defaults: LINK, clock: CLOCK });

    expect(view.result.current.origin).toEqual({ text: SLC.label, place: SLC });
    expect(view.result.current.destination).toEqual({ text: DENVER.label, place: DENVER });
    expect(view.result.current.departure).toEqual(departureOf(LINK_DEPARTURE, CLOCK.timeZone));
    expect(view.result.current.load).toBe(38_000);
    expect(view.result.current.interval).toBe(50);
    expect(view.result.current.scenario).toBe("calm");
  });

  it("keeps each field the visitor set meanwhile and fills the others", () => {
    const view = setupAddressArrival();
    act(() => {
      view.result.current.setOriginText("Salt");
      view.result.current.setLoad(12_000);
      view.result.current.setInterval(10);
      view.result.current.setScenario("severe");
    });

    view.rerender({ defaults: LINK, clock: CLOCK });

    expect(view.result.current.origin).toEqual({ text: "Salt", place: null });
    expect(view.result.current.load).toBe(12_000);
    expect(view.result.current.interval).toBe(10);
    expect(view.result.current.scenario).toBe("severe");
    expect(view.result.current.destination).toEqual({ text: DENVER.label, place: DENVER });
  });

  it("fills in from the address once: a visitor who empties a field is not given it again", () => {
    const view = setupAddressArrival();
    view.rerender({ defaults: LINK, clock: CLOCK });
    act(() => {
      view.result.current.pickOrigin(null);
      view.result.current.setOriginText("");
    });

    view.rerender({ defaults: LINK, clock: { ...CLOCK } });

    expect(view.result.current.origin).toEqual({ text: "", place: null });
  });

  it("leaves the defaults alone for an address that carries nothing", () => {
    const view = setupAddressArrival();

    view.rerender({ defaults: {}, clock: CLOCK });

    expect(view.result.current.origin).toEqual({ text: "", place: null });
    expect(view.result.current.load).toBeNaN();
    expect(view.result.current.interval).toBe(25);
    expect(view.result.current.scenario).toBeNull();
  });
});
