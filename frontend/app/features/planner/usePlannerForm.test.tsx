import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SAMPLING_INTERVALS_MI, type PlanRequest } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { DENVER, SLC } from "../../../test/plans";
import { NO_DEPARTURE, departureOf, type Clock } from "./departure";
import { usePlannerForm, type PlannerFormState } from "./usePlannerForm";

const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };

function setup(
  defaults: Parameters<typeof usePlannerForm>[0] = {},
  clock: Clock | null = CLOCK,
): { current: PlannerFormState } {
  return renderHook(() => usePlannerForm(defaults, clock)).result;
}

/** Fills a form that is valid at CLOCK's time. */
function fill(form: { current: PlannerFormState }): void {
  act(() => {
    form.current.pickOrigin(SLC);
    form.current.pickDestination(DENVER);
    form.current.setLoad(38_000);
  });
}

describe("usePlannerForm: starting values", () => {
  it("starts empty, with 25 mile checkpoints, live weather and departure now", () => {
    const form = setup();

    expect(form.current.origin).toEqual({ text: "", place: null });
    expect(form.current.destination).toEqual({ text: "", place: null });
    expect(Number.isNaN(form.current.load)).toBe(true);
    expect(form.current.interval).toBe(25);
    expect(form.current.scenario).toBeNull();
    expect(form.current.departure.time?.toString()).toBe("08:00:00");
    expect(form.current.errors).toEqual({});
  });

  it("starts with an empty departure while there is no clock (the prerendered page)", () => {
    expect(setup({}, null).current.departure).toEqual(NO_DEPARTURE);
  });

  it("starts from the inputs a link carried", () => {
    const form = setup({
      origin: SLC,
      destination: DENVER,
      depart: new Date("2026-10-22T20:15:00Z"),
      load: 45_000,
      interval: 50,
      scenario: "calm",
    });

    expect(form.current.origin).toEqual({ text: SLC.label, place: SLC });
    expect(form.current.destination).toEqual({ text: DENVER.label, place: DENVER });
    expect(form.current.departure).toEqual(
      departureOf(new Date("2026-10-22T20:15:00Z"), CLOCK.timeZone),
    );
    expect([form.current.load, form.current.interval, form.current.scenario]).toEqual([
      45_000,
      50,
      "calm",
    ]);
  });
});

describe("usePlannerForm: places", () => {
  it("shows the label of the place picked, and keeps the typed text when the pick is cleared", () => {
    const form = setup();

    act(() => {
      form.current.pickOrigin(SLC);
    });
    expect(form.current.origin).toEqual({ text: SLC.label, place: SLC });

    act(() => {
      form.current.setOriginText("Salt");
      form.current.pickOrigin(null);
    });
    expect(form.current.origin).toEqual({ text: "Salt", place: null });
  });

  it("keeps the typed destination when its pick is cleared, as it does for the origin", () => {
    const form = setup();

    act(() => {
      form.current.pickDestination(DENVER);
    });
    expect(form.current.destination).toEqual({ text: DENVER.label, place: DENVER });

    act(() => {
      form.current.setDestinationText("Den");
      form.current.pickDestination(null);
    });
    expect(form.current.destination).toEqual({ text: "Den", place: null });
  });

  it("stops counting a place as chosen once the text no longer is its label, and again when it is", () => {
    const form = setup();
    fill(form);

    act(() => {
      form.current.setDestinationText("Denver, Colorado, United States!");
    });
    let result: PlanRequest | null = null;
    act(() => {
      result = form.current.submit();
    });
    expect(result).toBeNull();
    expect(form.current.errors).toEqual({ destination: t("form.destination.error.required") });

    act(() => {
      form.current.setDestinationText(DENVER.label);
    });
    act(() => {
      result = form.current.submit();
    });
    expect(result).not.toBeNull();
  });

  it("swaps the two places, text and pick together", () => {
    const form = setup();
    fill(form);

    act(() => {
      form.current.swapPlaces();
    });

    expect(form.current.origin).toEqual({ text: DENVER.label, place: DENVER });
    expect(form.current.destination).toEqual({ text: SLC.label, place: SLC });
  });
});

describe("usePlannerForm: submit", () => {
  it("builds the POST /plans body from a valid form", () => {
    const form = setup();
    fill(form);
    act(() => {
      form.current.setInterval(10);
      form.current.setScenario("calm");
    });

    let request: ReturnType<PlannerFormState["submit"]> = null;
    act(() => {
      request = form.current.submit();
    });

    expect(request).toEqual({
      origin: SLC,
      destination: DENVER,
      departure_time: "2026-10-20T14:00:00Z",
      load_weight_lb: 38_000,
      sampling_interval_mi: 10,
      scenario: "calm",
    });
    expect(form.current.errors).toEqual({});
  });

  it("shows every problem next to its field and sends nothing", () => {
    const form = setup();

    let request: unknown = "unset";
    act(() => {
      request = form.current.submit();
    });

    expect(request).toBeNull();
    expect(form.current.errors).toEqual({
      origin: t("form.origin.error.required"),
      destination: t("form.destination.error.required"),
      load: t("form.load.error.required"),
    });
  });

  it("asks for a departure when there is no clock to start from", () => {
    const form = setup({ origin: SLC, destination: DENVER, load: 38_000 }, null);

    act(() => {
      form.current.submit();
    });

    expect(form.current.errors).toEqual({ departure: t("form.departure.error.required") });
  });

  it.each([
    [
      "origin",
      (f: PlannerFormState) => {
        f.setOriginText("x");
      },
    ],
    [
      "destination",
      (f: PlannerFormState) => {
        f.setDestinationText("x");
      },
    ],
    [
      "origin",
      (f: PlannerFormState) => {
        f.pickOrigin(SLC);
      },
    ],
    [
      "destination",
      (f: PlannerFormState) => {
        f.pickDestination(DENVER);
      },
    ],
    [
      "departure",
      (f: PlannerFormState) => {
        f.setDeparture(NO_DEPARTURE);
      },
    ],
    [
      "load",
      (f: PlannerFormState) => {
        f.setLoad(1);
      },
    ],
    [
      "interval",
      (f: PlannerFormState) => {
        f.setInterval(SAMPLING_INTERVALS_MI[0]);
      },
    ],
  ] as const)("clears the %s error when that field is edited, and only that one", (field, edit) => {
    const form = setup();
    act(() => {
      form.current.showErrors({
        origin: "o",
        destination: "d",
        departure: "p",
        load: "l",
        interval: "i",
      });
    });

    act(() => {
      edit(form.current);
    });

    const remaining = Object.keys(form.current.errors);
    expect(remaining).not.toContain(field);
    expect(remaining).toHaveLength(4);
  });

  it("clears both place errors when the places are swapped", () => {
    const form = setup();
    act(() => {
      form.current.showErrors({ origin: "o", destination: "d", load: "l" });
    });

    act(() => {
      form.current.swapPlaces();
    });

    expect(form.current.errors).toEqual({ load: "l" });
  });

  it("shows the server's errors and keeps the scenario edit free of them", () => {
    const form = setup();
    act(() => {
      form.current.showErrors({ departure: t("form.departure.error.range") });
    });
    expect(form.current.errors).toEqual({ departure: t("form.departure.error.range") });

    act(() => {
      form.current.setScenario("calm");
    });

    expect(form.current.errors).toEqual({ departure: t("form.departure.error.range") });
    expect(form.current.scenario).toBe("calm");
  });
});
