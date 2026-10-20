import type { z } from "zod";

import {
  geocodeResponseSchema,
  heatmapSchema,
  planSchema,
  problemSchema,
  riskRulesSchema,
  scenariosResponseSchema,
  type GeocodeResponse,
  type Heatmap,
  type Plan,
  type PlanRequest,
  type ProblemFieldError,
  type RiskRules,
  type Scenario,
} from "./contract";
import { ApiError, CLIENT_ERROR_CODES, parseRetryAfterSeconds, toFieldError } from "./errors";

/** Same-origin API prefix: Vercel serves SPA and API together; Vite proxies it in development. */
export const DEFAULT_BASE_URL = "/api/v1";

/** Per-attempt timeouts in milliseconds, sized to the contract's server-side budgets. */
export const DEFAULT_TIMEOUTS_MS = {
  geocode: 8_000,
  createPlan: 35_000,
  getPlan: 15_000,
  getHeatmap: 30_000,
  getRules: 10_000,
  getScenarios: 10_000,
} as const;

/** Retry behaviour for idempotent GETs (POST is never retried). */
export interface RetryPolicy {
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  /** First backoff ceiling; doubles on each further attempt. */
  readonly baseDelayMs: number;
  /** Upper bound of the backoff ceiling. */
  readonly maxDelayMs: number;
  /** A server `Retry-After` longer than this is surfaced to the caller instead of waited out. */
  readonly maxRetryAfterMs: number;
}

/** Two retries with full-jitter exponential backoff, waiting out `Retry-After` up to ten seconds. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
  maxRetryAfterMs: 10_000,
};

/** Per-call options shared by every endpoint method. */
export interface RequestOptions {
  /** Cancels the request (and any pending retry); the call rejects with code `aborted`. */
  readonly signal?: AbortSignal | undefined;
  /** Per-attempt timeout; overrides the client and endpoint defaults. */
  readonly timeoutMs?: number | undefined;
}

/** What `onResponse` reports about each HTTP response (including error responses). */
export interface ResponseInfo {
  readonly method: "GET" | "POST";
  /** Path below the base URL, e.g. `/geocode`. */
  readonly path: string;
  readonly status: number;
  /** The `X-Request-ID` read back from the response, when the server sent one. */
  readonly requestId: string | null;
  readonly durationMs: number;
  /** 1 for the first attempt, 2 for the first retry, and so on. */
  readonly attempt: number;
}

/** Construction options; every seam (fetch, clock, jitter, sleep) is injectable for tests. */
export interface ApiClientOptions {
  readonly baseUrl?: string;
  /** Defaults to the current global `fetch`, looked up per request so mocks installed later apply. */
  readonly fetch?: typeof fetch;
  /** Overrides every endpoint's default per-attempt timeout. */
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Resolves after `ms`, or early when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Source of jitter in [0, 1). */
  readonly random?: () => number;
  /** Clock in epoch milliseconds (used for `Retry-After` dates and durations). */
  readonly now?: () => number;
  readonly onResponse?: (info: ResponseInfo) => void;
}

/** Typed access to every browser-facing endpoint of `/api/v1`. */
export interface ApiClient {
  geocode: (
    query: string,
    options?: RequestOptions & { readonly limit?: number | undefined },
  ) => Promise<GeocodeResponse>;
  createPlan: (request: PlanRequest, options?: RequestOptions) => Promise<Plan>;
  getPlan: (planId: string, options?: RequestOptions) => Promise<Plan>;
  getHeatmap: (planId: string, options?: RequestOptions) => Promise<Heatmap>;
  getRules: (options?: RequestOptions) => Promise<RiskRules>;
  getScenarios: (options?: RequestOptions) => Promise<Scenario[]>;
}

type Attempt<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

interface RequestSpec<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  readonly defaultTimeoutMs: number;
  readonly options: RequestOptions | undefined;
}

/** Cap on the field errors reported for a contract violation (a bad heatmap could yield thousands). */
const MAX_REPORTED_ISSUES = 20;
/** How many of those are spelled out in the human-readable detail. */
const MAX_SUMMARISED_ISSUES = 3;

function describeIssue(issue: z.core.$ZodIssue): string {
  return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function tryParseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function abortedError(): ApiError {
  return new ApiError({ status: 0, code: CLIENT_ERROR_CODES.aborted, title: "Request cancelled" });
}

/** Classifies a failure that happened before a complete response was read. */
function interruptedError(
  cause: unknown,
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): ApiError {
  if (userSignal?.aborted) return abortedError();
  if (timeoutSignal.aborted) {
    return new ApiError({
      status: 0,
      code: CLIENT_ERROR_CODES.timeout,
      title: "The request timed out",
      cause,
    });
  }
  return new ApiError({
    status: 0,
    code: CLIENT_ERROR_CODES.network,
    title: "Could not reach the server",
    detail: "Check your connection and try again.",
    cause,
  });
}

function invalidResponse(
  status: number,
  requestId: string | null,
  detail: string,
  errors: ProblemFieldError[] = [],
): ApiError {
  return new ApiError({
    status,
    code: CLIENT_ERROR_CODES.invalidResponse,
    title: "Unexpected response from the server",
    detail,
    errors,
    requestId,
  });
}

/**
 * Creates the API client. All endpoint methods validate the response against the contract schemas,
 * retry idempotent GETs with jittered backoff, and reject with {@link ApiError} for every failure.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const send: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  function buildUrl(path: string, query: RequestSpec<unknown>["query"]): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const text = search.toString();
    return `${baseUrl}${path}${text ? `?${text}` : ""}`;
  }

  function problemError(response: Response, text: string, requestId: string | null): ApiError {
    const retryAfterS = parseRetryAfterSeconds(response.headers.get("Retry-After"), now());
    const parsed = tryParseJson(text);
    const problem = parsed.ok ? problemSchema.safeParse(parsed.value) : undefined;
    if (problem?.success) {
      const body = problem.data;
      return new ApiError({
        status: response.status,
        code: body.code,
        title: body.title,
        detail: body.detail,
        errors: body.errors,
        requestId: requestId ?? body.request_id,
        retryAfterS,
      });
    }
    return new ApiError({
      status: response.status,
      code: `http_${String(response.status)}`,
      title: response.statusText || "Request failed",
      requestId,
      retryAfterS,
    });
  }

  function validated<T>(
    spec: RequestSpec<T>,
    status: number,
    text: string,
    requestId: string | null,
  ): Attempt<T> {
    const parsed = tryParseJson(text);
    if (!parsed.ok) {
      return {
        ok: false,
        error: invalidResponse(status, requestId, "The response body is not valid JSON"),
      };
    }
    const result = spec.schema.safeParse(parsed.value);
    if (result.success) return { ok: true, value: result.data };
    const summary = result.error.issues
      .slice(0, MAX_SUMMARISED_ISSUES)
      .map(describeIssue)
      .join("; ");
    const detail = `The response does not match the API contract: ${summary}`;
    const errors = result.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((issue) => toFieldError(issue));
    return { ok: false, error: invalidResponse(status, requestId, detail, errors) };
  }

  async function attemptOnce<T>(
    spec: RequestSpec<T>,
    attempt: number,
    userSignal: AbortSignal | undefined,
  ): Promise<Attempt<T>> {
    const timeoutMs = spec.options?.timeoutMs ?? options.timeoutMs ?? spec.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
    const startedAt = now();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    let text: string;
    try {
      response = await send(buildUrl(spec.path, spec.query), {
        method: spec.method,
        headers,
        signal,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      });
      text = await response.text();
    } catch (cause) {
      return { ok: false, error: interruptedError(cause, userSignal, timeoutSignal) };
    }

    const requestId = response.headers.get("X-Request-ID");
    options.onResponse?.({
      method: spec.method,
      path: spec.path,
      status: response.status,
      requestId,
      durationMs: now() - startedAt,
      attempt,
    });
    if (!response.ok) return { ok: false, error: problemError(response, text, requestId) };
    return validated(spec, response.status, text, requestId);
  }

  /** Delay before retry number `attempt`, or `null` when the server asked for too long a wait. */
  function retryDelayMs(error: ApiError, attempt: number): number | null {
    const retryAfterMs = (error.retryAfterS ?? 0) * 1000;
    if (retryAfterMs > policy.maxRetryAfterMs) return null;
    const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.max(random() * ceiling, retryAfterMs);
  }

  async function execute<T>(spec: RequestSpec<T>): Promise<T> {
    const userSignal = spec.options?.signal;
    const maxAttempts = spec.method === "GET" ? policy.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      if (userSignal?.aborted) throw abortedError();
      const result = await attemptOnce(spec, attempt, userSignal);
      if (result.ok) return result.value;
      const delayMs =
        attempt < maxAttempts && result.error.retryable
          ? retryDelayMs(result.error, attempt)
          : null;
      if (delayMs === null) throw result.error;
      await sleep(delayMs, userSignal);
    }
  }

  return {
    geocode: (query, callOptions) =>
      execute({
        method: "GET",
        path: "/geocode",
        query: { q: query, limit: callOptions?.limit },
        schema: geocodeResponseSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.geocode,
        options: callOptions,
      }),
    createPlan: (request, callOptions) =>
      execute({
        method: "POST",
        path: "/plans",
        body: request,
        schema: planSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.createPlan,
        options: callOptions,
      }),
    getPlan: (planId, callOptions) =>
      execute({
        method: "GET",
        path: `/plans/${encodeURIComponent(planId)}`,
        schema: planSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.getPlan,
        options: callOptions,
      }),
    getHeatmap: (planId, callOptions) =>
      execute({
        method: "GET",
        path: `/plans/${encodeURIComponent(planId)}/heatmap`,
        schema: heatmapSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.getHeatmap,
        options: callOptions,
      }),
    getRules: (callOptions) =>
      execute({
        method: "GET",
        path: "/rules",
        schema: riskRulesSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.getRules,
        options: callOptions,
      }),
    getScenarios: (callOptions) =>
      execute({
        method: "GET",
        path: "/scenarios",
        schema: scenariosResponseSchema,
        defaultTimeoutMs: DEFAULT_TIMEOUTS_MS.getScenarios,
        options: callOptions,
      }),
  };
}
