import type { z } from "zod";

import type { ProblemFieldError } from "./contract";

/** Error codes the client itself raises; server problem codes are free-form strings. */
export const CLIENT_ERROR_CODES = {
  /** No HTTP response at all: offline, DNS failure, connection reset. */
  network: "network_error",
  /** The per-request timeout expired before a complete response arrived. */
  timeout: "timeout",
  /** The caller cancelled the request (superseded search, unmounted view, cancel button). */
  aborted: "aborted",
  /** A 2xx response whose body is not valid JSON or does not match the API contract. */
  invalidResponse: "invalid_response",
} as const;

/** HTTP statuses where trying again can succeed: timeout, rate limit, transient server faults. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const RETRYABLE_CLIENT_CODES: ReadonlySet<string> = new Set([
  CLIENT_ERROR_CODES.network,
  CLIENT_ERROR_CODES.timeout,
]);

/** Everything needed to build an {@link ApiError}. */
export interface ApiErrorInit {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
  /** Machine-readable code (`routing_unavailable`, `invalid_response`, `http_502`, ...). */
  readonly code: string;
  /** Short human-readable summary. */
  readonly title: string;
  /** Longer explanation, when the server gave one. */
  readonly detail?: string | null | undefined;
  /** Per-field validation failures (422). */
  readonly errors?: readonly ProblemFieldError[] | undefined;
  /** The server's `X-Request-ID`, for support and log correlation. */
  readonly requestId?: string | null | undefined;
  /** Seconds the server asked the client to wait (`Retry-After`). */
  readonly retryAfterS?: number | null | undefined;
  /** The underlying failure, when one exists (a `fetch` TypeError, ...). */
  readonly cause?: unknown;
}

/**
 * The single error type every API failure becomes: HTTP problems (`application/problem+json`),
 * network failures, timeouts, cancellations and responses that break the contract.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | null;
  readonly errors: readonly ProblemFieldError[];
  readonly requestId: string | null;
  readonly retryAfterS: number | null;
  /** Whether offering the user a retry makes sense (network, timeout, 408/429/5xx). */
  readonly retryable: boolean;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    const probeTest = Reflect.get(globalThis, "__probeTest") as string | undefined;
    if (probeTest?.includes("shows the progress") === true) {
      const frames = (new Error("trace").stack ?? "")
        .split("\n")
        .slice(2, 8)
        .map((frame) => frame.trim().replace(/^at /u, ""))
        .join(" <- ");
      process.stdout.write(
        `[probe] ApiError status=${String(init.status)} code=${init.code} title=${init.title} cause=${String(init.cause)} stack=${frames}\n`,
      );
    }
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail ?? null;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId ?? null;
    this.retryAfterS = init.retryAfterS ?? null;
    this.retryable = RETRYABLE_STATUSES.has(init.status) || RETRYABLE_CLIENT_CODES.has(init.code);
  }
}

/** Narrows an unknown thrown value to {@link ApiError}. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * A Zod issue as an API field error. `loc` keeps array indexes numeric (as the API's own 422s do);
 * `prefix` goes in front, e.g. `["body"]` for a rejected request body.
 */
export function toFieldError(
  issue: z.core.$ZodIssue,
  prefix: readonly string[] = [],
): ProblemFieldError {
  return {
    loc: [
      ...prefix,
      ...issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    ],
    msg: issue.message,
    type: issue.code,
  };
}

/** Whether `value` is the error of a request the caller cancelled (safe to ignore silently). */
export function isAbortedError(value: unknown): boolean {
  return value instanceof ApiError && value.code === CLIENT_ERROR_CODES.aborted;
}

/**
 * Reads a `Retry-After` header (delta-seconds or an HTTP date) as whole seconds, rounded up so a
 * retry never fires early. Returns `null` when the header is absent or unusable.
 */
export function parseRetryAfterSeconds(value: string | null, nowMs: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  if (!/[a-z]{3}/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}
