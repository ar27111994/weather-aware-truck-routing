import { describe, expect, it } from "vitest";

import { at } from "../lib/checked";
import {
  ApiError,
  CLIENT_ERROR_CODES,
  isAbortedError,
  isApiError,
  parseRetryAfterSeconds,
  toFieldError,
} from "./errors";
import { z } from "./zod";

const base = { status: 503, code: "routing_unavailable", title: "Routing unavailable" };

describe("ApiError", () => {
  it("carries every field of the problem document with safe defaults", () => {
    const error = new ApiError(base);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(503);
    expect(error.code).toBe("routing_unavailable");
    expect(error.title).toBe("Routing unavailable");
    expect(error.detail).toBeNull();
    expect(error.errors).toEqual([]);
    expect(error.requestId).toBeNull();
    expect(error.retryAfterS).toBeNull();
  });

  it("uses the detail as the message when present, otherwise the title", () => {
    expect(new ApiError(base).message).toBe("Routing unavailable");
    expect(new ApiError({ ...base, detail: "Valhalla timed out" }).message).toBe(
      "Valhalla timed out",
    );
  });

  it("keeps field errors, request id, retry delay and the original cause", () => {
    const cause = new TypeError("boom");
    const errors = [{ loc: ["body", "origin"], msg: "bad", type: "value_error" }];
    const error = new ApiError({
      ...base,
      status: 422,
      errors,
      requestId: "req-12345678",
      retryAfterS: 7,
      cause,
    });
    expect(error.errors).toEqual(errors);
    expect(error.requestId).toBe("req-12345678");
    expect(error.retryAfterS).toBe(7);
    expect(error.cause).toBe(cause);
  });

  it.each([408, 429, 500, 502, 503, 504])("marks HTTP %i as retryable", (status) => {
    expect(new ApiError({ ...base, status }).retryable).toBe(true);
  });

  it.each([400, 401, 404, 413, 422, 501])("does not mark HTTP %i as retryable", (status) => {
    expect(new ApiError({ ...base, status }).retryable).toBe(false);
  });

  it("marks network failures and timeouts as retryable, aborts and bad responses as not", () => {
    const client = (code: string): ApiError => new ApiError({ status: 0, code, title: code });
    expect(client(CLIENT_ERROR_CODES.network).retryable).toBe(true);
    expect(client(CLIENT_ERROR_CODES.timeout).retryable).toBe(true);
    expect(client(CLIENT_ERROR_CODES.aborted).retryable).toBe(false);
    expect(
      new ApiError({ status: 200, code: CLIENT_ERROR_CODES.invalidResponse, title: "x" }).retryable,
    ).toBe(false);
  });
});

describe("type guards", () => {
  it("isApiError recognises only ApiError instances", () => {
    expect(isApiError(new ApiError(base))).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError({ code: "aborted" })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it("isAbortedError is true only for the client's aborted code", () => {
    expect(
      isAbortedError(
        new ApiError({ status: 0, code: CLIENT_ERROR_CODES.aborted, title: "Aborted" }),
      ),
    ).toBe(true);
    expect(isAbortedError(new ApiError(base))).toBe(false);
    expect(isAbortedError(new Error("aborted"))).toBe(false);
  });
});

describe("toFieldError", () => {
  const schema = z.object({ stops: z.array(z.object({ lat: z.number() })) });

  function firstIssue(input: unknown): z.core.$ZodIssue {
    const result = schema.safeParse(input);
    if (result.success) throw new Error("expected the input to fail validation");
    return at(result.error.issues, 0);
  }

  it("keeps array indexes numeric and property names textual in loc", () => {
    const error = toFieldError(firstIssue({ stops: [{ lat: 1 }, { lat: "x" }] }));

    expect(error.loc).toEqual(["stops", 1, "lat"]);
    expect(error.type).toBe("invalid_type");
    expect(error.msg.length).toBeGreaterThan(0);
  });

  it("puts a prefix in front of the path, like the API's body and query markers", () => {
    const error = toFieldError(firstIssue({ stops: [{ lat: "x" }] }), ["body"]);

    expect(error.loc).toEqual(["body", "stops", 0, "lat"]);
  });
});

describe("parseRetryAfterSeconds", () => {
  const now = Date.parse("2026-10-20T14:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfterSeconds("7", now)).toBe(7);
    expect(parseRetryAfterSeconds(" 0 ", now)).toBe(0);
  });

  it("rounds fractional seconds up so a retry never fires early", () => {
    expect(parseRetryAfterSeconds("1.2", now)).toBe(2);
  });

  it("reads an HTTP date relative to now, never below zero", () => {
    expect(parseRetryAfterSeconds("Tue, 20 Oct 2026 14:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfterSeconds("Tue, 20 Oct 2026 13:59:00 GMT", now)).toBe(0);
  });

  it.each([[null], [""], ["soon"], ["-5"], ["NaN"], ["Infinity"]])(
    "returns null for %j",
    (value) => {
      expect(parseRetryAfterSeconds(value, now)).toBeNull();
    },
  );
});
