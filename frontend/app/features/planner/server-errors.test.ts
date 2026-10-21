import { describe, expect, it } from "vitest";

import { ApiError } from "../../api/errors";
import { t } from "../../design-system/foundation/strings";
import { planFailure } from "./server-errors";

function problem(
  status: number,
  code: string,
  errors: readonly { loc: (string | number)[]; msg: string; type: string }[] = [],
): ApiError {
  return new ApiError({ status, code, title: "Invalid request", errors });
}

describe("planFailure", () => {
  it("blames the destination for a domain 422 about the same place twice", () => {
    expect(planFailure(problem(422, "same_origin_destination"))).toEqual({
      fieldErrors: { destination: t("form.destination.error.tooClose") },
      showsPanel: false,
    });
  });

  it("blames the departure for a domain 422 about the window", () => {
    expect(planFailure(problem(422, "departure_out_of_range"))).toEqual({
      fieldErrors: { departure: t("form.departure.error.range") },
      showsPanel: false,
    });
  });

  it("marks each field a validation 422 names in its errors list, in the form's own words", () => {
    const failure = planFailure(
      problem(422, "validation_error", [
        { loc: ["body", "load_weight_lb"], msg: "too big", type: "less_than_equal" },
        { loc: ["body", "origin", "lat"], msg: "bad", type: "greater_than_equal" },
        { loc: ["body", "destination", "label"], msg: "bad", type: "string_too_short" },
        { loc: ["body", "departure_time"], msg: "bad", type: "value_error" },
        { loc: ["body", "sampling_interval_mi"], msg: "bad", type: "literal_error" },
      ]),
    );

    expect(failure).toEqual({
      fieldErrors: {
        load: t("form.load.error.range"),
        origin: t("form.origin.error.required"),
        destination: t("form.destination.error.required"),
        departure: t("form.departure.error.range"),
        interval: t("form.interval.error"),
      },
      showsPanel: false,
    });
  });

  it("keeps the first message a field gets when the server names it twice", () => {
    const failure = planFailure(
      problem(422, "same_origin_destination", [
        { loc: ["body", "destination"], msg: "again", type: "value_error" },
      ]),
    );

    expect(failure.fieldErrors).toEqual({ destination: t("form.destination.error.tooClose") });
  });

  it.each([
    ["a location outside the body", ["query", "origin"]],
    ["a body key the form does not have", ["body", "scenario"]],
    ["a path that is only an index", [0]],
    ["no path at all", []],
  ])("shows the panel when a 422 points at %s", (_name, loc) => {
    expect(planFailure(problem(422, "validation_error", [{ loc, msg: "x", type: "x" }]))).toEqual({
      fieldErrors: {},
      showsPanel: true,
    });
  });

  it.each([
    [422, "no_route_found"],
    [422, "route_too_long"],
    [422, "too_many_checkpoints"],
    [429, "rate_limited"],
    [502, "routing_unavailable"],
    [503, "weather_capacity_exhausted"],
    [0, "network_error"],
  ])("shows the panel for %i %s: no field is to blame", (status, code) => {
    expect(planFailure(problem(status, code))).toEqual({ fieldErrors: {}, showsPanel: true });
  });

  it("ignores an errors list on a status that is not 422", () => {
    const failure = planFailure(
      problem(400, "bad_request", [{ loc: ["body", "load_weight_lb"], msg: "x", type: "x" }]),
    );

    expect(failure).toEqual({ fieldErrors: {}, showsPanel: true });
  });
});
