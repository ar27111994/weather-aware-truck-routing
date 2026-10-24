import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SAMPLING_INTERVALS_MI } from "../../api/contract";
import { TRIP_KEYS } from "./trip-keys";
import { buildTripSearch, parseTripSearch, type TripUrlState } from "./trip-url";

const PLAN_ID = "pln_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SLC = { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" };
const DENVER = { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" };

describe("parseTripSearch", () => {
  it("reads nothing from an empty address", () => {
    expect(parseTripSearch("")).toEqual({});
    expect(parseTripSearch("?")).toEqual({});
    expect(parseTripSearch(new URLSearchParams())).toEqual({});
  });

  it("reads every parameter of a full link", () => {
    const search = buildTripSearch({
      origin: SLC,
      destination: DENVER,
      depart: new Date("2026-10-20T14:00:00Z"),
      load: 38_000,
      interval: 50,
      scenario: "severe-on-fastest",
      plan: PLAN_ID,
    });

    expect(parseTripSearch(search)).toEqual({
      origin: SLC,
      destination: DENVER,
      depart: new Date("2026-10-20T14:00:00Z"),
      load: 38_000,
      interval: 50,
      scenario: "severe-on-fastest",
      plan: PLAN_ID,
    });
  });

  it("accepts parameters parsed already", () => {
    const params = new URLSearchParams({ load: "20000", interval: "10" });

    expect(parseTripSearch(params)).toEqual({ load: 20_000, interval: 10 });
  });

  it("keeps a plan id on its own (a shared result link)", () => {
    expect(parseTripSearch(`?plan=${PLAN_ID}`)).toEqual({ plan: PLAN_ID });
  });

  it("ignores parameters it does not know and any order", () => {
    expect(parseTripSearch(`?utm_source=mail&plan=${PLAN_ID}&load=5`)).toEqual({
      plan: PLAN_ID,
      load: 5,
    });
  });

  it.each([
    ["a plan id of the wrong shape", "plan=pln_short"],
    ["a plan id in the wrong case", "plan=pln_01jabcdefghjkmnpqrstvwxyz0"],
    ["a load with a sign", "load=-5"],
    ["a load with decimals", "load=1.5"],
    ["a load that is not a number", "load=heavy"],
    ["a load of seven digits", "load=1000000"],
    ["an interval the API does not offer", "interval=15"],
    ["an interval that is text", "interval=often"],
    ["a scenario id with a slash", "scenario=a%2Fb"],
    ["a scenario id that is empty", "scenario="],
    ["a scenario id over 64 characters", `scenario=${"a".repeat(65)}`],
    ["a departure that is not an instant", "depart=tomorrow"],
    ["a departure with a zone offset instead of Z", "depart=2026-10-20T14:00:00-06:00"],
    ["a departure that matches the shape but not the calendar", "depart=2026-13-45T14:00:00Z"],
  ])("drops %s", (_name, search) => {
    expect(parseTripSearch(search)).toEqual({});
  });

  it.each([
    ["no @", "Denver"],
    ["no label", "@39.7,-104.9"],
    ["one coordinate", "Denver@39.7"],
    ["three coordinates", "Denver@39.7,-104.9,5"],
    ["a coordinate with exponent", "Denver@3e1,-104.9"],
    ["a coordinate that is empty", "Denver@,-104.9"],
    ["a latitude past the pole", "Denver@91,-104.9"],
    ["a longitude past the date line", "Denver@39.7,-181"],
    ["more than six decimals", "Denver@39.1234567,-104.9"],
    ["a label over 200 characters", `${"x".repeat(201)}@39.7,-104.9`],
  ])("drops a place with %s", (_name, value) => {
    expect(parseTripSearch(new URLSearchParams({ origin: value, destination: value }))).toEqual({});
  });

  it("reads a label that contains an @ or commas (the last @ separates the coordinates)", () => {
    const place = { lat: 39.7392, lon: -104.9903, label: "Denver, CO @ the airport" };

    expect(parseTripSearch(buildTripSearch({ origin: place }))).toEqual({ origin: place });
  });

  it("floors the departure to the minute", () => {
    expect(parseTripSearch("depart=2026-10-20T14:00:42.5Z")).toEqual({
      depart: new Date("2026-10-20T14:00:00Z"),
    });
  });

  it("accepts a departure written without seconds", () => {
    expect(parseTripSearch("depart=2026-10-20T14:05Z")).toEqual({
      depart: new Date("2026-10-20T14:05:00Z"),
    });
  });
});

describe("buildTripSearch", () => {
  it("is empty when there is nothing to say", () => {
    expect(buildTripSearch({})).toBe("");
  });

  it("writes the parameters in a fixed order whatever order the state was built in", () => {
    const state: TripUrlState = {
      plan: PLAN_ID,
      scenario: "calm",
      interval: 25,
      load: 38_000,
      depart: new Date("2026-10-20T14:00:00Z"),
      destination: DENVER,
      origin: SLC,
    };

    const keys = [...new URLSearchParams(buildTripSearch(state)).keys()];

    expect(keys).toEqual([
      "origin",
      "destination",
      "depart",
      "load",
      "interval",
      "scenario",
      "plan",
    ]);
  });

  it("writes the departure as a UTC instant to the minute, without milliseconds", () => {
    const search = buildTripSearch({ depart: new Date("2026-10-20T14:00:42.789Z") });

    expect(new URLSearchParams(search).get("depart")).toBe("2026-10-20T14:00:00Z");
  });

  it("writes coordinates with at most six decimals and never an exponent or a negative zero", () => {
    const search = buildTripSearch({
      origin: { lat: 1e-9, lon: -0, label: "Null Island" },
    });

    expect(new URLSearchParams(search).get("origin")).toBe("Null Island@0,0");
  });

  it("round-trips any trip the form can build (property)", () => {
    const degrees = (limit: number): fc.Arbitrary<number> =>
      fc.integer({ min: -limit * 1e6, max: limit * 1e6 }).map((micro) => micro / 1e6 + 0);
    const place = fc.record({
      lat: degrees(90),
      lon: degrees(180),
      label: fc.string({ minLength: 1, maxLength: 200 }).filter((text) => text.trim() !== ""),
    });
    const state = fc.record(
      {
        origin: place,
        destination: place,
        depart: fc
          .integer({ min: 0, max: 4_000_000_000 })
          .map((seconds) => new Date(Math.floor(seconds / 60) * 60_000)),
        load: fc.integer({ min: 0, max: 80_000 }),
        interval: fc.constantFrom(...SAMPLING_INTERVALS_MI),
        scenario: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        plan: fc.constant(PLAN_ID),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(state, (value) => {
        expect(parseTripSearch(buildTripSearch(value))).toEqual(value);
      }),
    );
  });
});

describe("TRIP_KEYS", () => {
  // The page's first code decides with this list whether a link carries a trip (R4-02); it must
  // name exactly the parameters the builder writes and the parser reads.
  it("names every parameter that a full trip is written with, in the order it is written", () => {
    const search = buildTripSearch({
      origin: SLC,
      destination: DENVER,
      depart: new Date("2026-10-20T14:00:00Z"),
      load: 38_000,
      interval: 50,
      scenario: "severe-on-fastest",
      plan: PLAN_ID,
    });

    expect([...new URLSearchParams(search).keys()]).toEqual([...TRIP_KEYS]);
  });

  it.each(TRIP_KEYS)("is read by the parser: %s", (key) => {
    const values: Record<(typeof TRIP_KEYS)[number], string> = {
      origin: "Salt Lake City@40.7608,-111.891",
      destination: "Denver@39.7392,-104.9903",
      depart: "2026-10-20T14:00:00Z",
      load: "38000",
      interval: "50",
      scenario: "severe-on-fastest",
      plan: PLAN_ID,
    };

    expect(Object.keys(parseTripSearch(`?${key}=${encodeURIComponent(values[key])}`))).toEqual([
      key,
    ]);
  });
});
