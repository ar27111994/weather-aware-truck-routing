/**
 * MSW handlers for every browser-facing endpoint of `/api/v1`, serving the deterministic fixtures
 * of this folder, plus ready-made error fixtures (`errorFixtures`) for the failure states.
 *
 * Tests:   `createMockServer()` from `./node` (Node only), then `server.listen()`.
 * Browser: `setupWorker(...createMockApi().handlers)` from `msw/browser`; the `msw/vite` plugin
 *          (`msw({ mode: "worker-only" })`) serves the worker script `mockServiceWorker.js`.
 *
 * This module is browser-safe and must stay so: it never imports `msw/node` (see `node.ts`).
 *
 * The cron endpoint (`/internal/maintenance`) is server-side only and is not mocked.
 */
import { http, HttpResponse } from "msw/http";
import type { RequestHandler } from "msw";

import { RISK_RULES } from "../../lib/risk";
import { planRequestSchema, type Heatmap, type Plan, type ProblemFieldError } from "../contract";
import { toFieldError } from "../errors";
import { FixtureError, buildHeatmap, buildPlan } from "./plan-builder";
import { GEOCODE_CATALOG, searchGeocode } from "./trips";
import { SCENARIO_CATALOG } from "./weather";

const PROBLEMS_URL =
  "https://github.com/ar27111994/weather-aware-truck-routing/blob/main/docs/api/problems.md";
const API = "*/api/v1";
const PROBLEM_HEADERS = { "Content-Type": "application/problem+json" } as const;

/** The in-memory backend behind the handlers. */
export interface MockApi {
  readonly handlers: RequestHandler[];
  /** Plans created through `POST /plans`, by id. */
  readonly plans: Map<string, Plan>;
  readonly heatmaps: Map<string, Heatmap>;
}

interface ProblemOptions {
  readonly detail?: string;
  readonly errors?: ProblemFieldError[];
  readonly retryAfterS?: number;
  readonly requestId?: string;
}

/** An RFC 9457 problem response like the real API's (`application/problem+json`). */
export function problemResponse(
  status: number,
  code: string,
  title: string,
  options: ProblemOptions = {},
): Response {
  return HttpResponse.json(
    {
      type: `${PROBLEMS_URL}#${code}`,
      title,
      status,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      code,
      ...(options.errors === undefined ? {} : { errors: options.errors }),
      request_id: options.requestId ?? "mock-req-000000",
    },
    {
      status,
      headers: {
        ...PROBLEM_HEADERS,
        "X-Request-ID": options.requestId ?? "mock-req-000000",
        ...(options.retryAfterS === undefined
          ? {}
          : { "Retry-After": String(options.retryAfterS) }),
      },
    },
  );
}

/** Creates a fresh in-memory mock backend (own plan store and request counter). */
export function createMockApi(): MockApi {
  const plans = new Map<string, Plan>();
  const heatmaps = new Map<string, Heatmap>();
  let counter = 0;
  const requestId = (): string => {
    counter += 1;
    return `mock-req-${String(counter).padStart(6, "0")}`;
  };
  const json = (
    body: Parameters<typeof HttpResponse.json>[0],
    status = 200,
    headers: Record<string, string> = {},
  ): Response =>
    HttpResponse.json(body, { status, headers: { "X-Request-ID": requestId(), ...headers } });
  const problem = (
    status: number,
    code: string,
    title: string,
    options: ProblemOptions = {},
  ): Response => problemResponse(status, code, title, { ...options, requestId: requestId() });

  const handlers: RequestHandler[] = [
    http.get(`${API}/health`, () =>
      json({ status: "ok", version: "0.0.0-mock", commit: "mock000" }),
    ),
    http.get(`${API}/health/ready`, () => json({ status: "ok" })),
    http.get(`${API}/geocode`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const query = params.get("q") ?? "";
      const limit = Number(params.get("limit") ?? 5);
      const length = Array.from(query.trim()).length;
      if (length < 2 || length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 8) {
        return problem(422, "validation_error", "Invalid request", {
          detail: "q must be 2..120 characters and limit 1..8",
          errors: [
            {
              loc: ["query", "q"],
              msg: "q must be 2..120 characters and limit 1..8",
              type: "value_error",
            },
          ],
        });
      }
      return json({ query: query.trim().toLowerCase(), results: searchGeocode(query, limit) });
    }),
    http.post(`${API}/plans`, async ({ request }) => {
      if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) {
        return problem(400, "invalid_content_type", "Unsupported content type", {
          detail: "Send application/json",
        });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return problem(400, "invalid_json", "Malformed JSON", {
          detail: "The request body is not valid JSON",
        });
      }
      const parsed = planRequestSchema.safeParse(body);
      if (!parsed.success) {
        return problem(422, "validation_error", "Invalid request", {
          errors: parsed.error.issues.map((issue) => toFieldError(issue, ["body"])),
        });
      }
      try {
        const plan = buildPlan(parsed.data);
        const existing = plans.get(plan.plan_id);
        plans.set(plan.plan_id, existing ?? plan);
        return json(existing ?? plan, existing ? 200 : 201, {
          Location: `/api/v1/plans/${plan.plan_id}`,
        });
      } catch (error) {
        return error instanceof FixtureError
          ? problem(422, error.code, "Invalid request", { detail: error.message })
          : problem(500, "internal_error", "Internal error", {
              detail: "The mock backend failed unexpectedly",
            });
      }
    }),
    http.get(`${API}/plans/:planId`, ({ params }) => {
      const plan = plans.get(String(params["planId"]));
      return plan ? json(plan) : problem(404, "plan_not_found", "Plan not found");
    }),
    http.get(`${API}/plans/:planId/heatmap`, ({ params }) => {
      const planId = String(params["planId"]);
      const plan = plans.get(planId);
      if (!plan) return problem(404, "plan_not_found", "Plan not found");
      const heatmap = heatmaps.get(planId) ?? buildHeatmap(plan);
      heatmaps.set(planId, heatmap);
      return json(heatmap);
    }),
    http.get(`${API}/rules`, () => json(RISK_RULES)),
    http.get(`${API}/scenarios`, () => json(SCENARIO_CATALOG)),
  ];
  return { handlers, plans, heatmaps };
}

/** Which endpoint an error fixture replaces. */
export interface FailureTarget {
  readonly method?: "get" | "post";
  /** Path below `/api/v1`, with a leading slash. */
  readonly path?: string;
}

function target(options: FailureTarget): [method: "get" | "post", url: string] {
  return [options.method ?? "post", `${API}${options.path ?? "/plans"}`];
}

/**
 * Handlers that make one endpoint fail the way the real API (or the network) can fail; install
 * them with `server.use(...)`. They default to `POST /plans`.
 */
export const errorFixtures = {
  /** 422 with a field error, like a rejected form value. */
  validation422: (options: FailureTarget = {}): RequestHandler => {
    const [method, url] = target(options);
    return http[method](url, () =>
      problemResponse(422, "departure_out_of_range", "Invalid request", {
        detail: "departure_time must be within the next 120 hours",
        errors: [
          {
            loc: ["body", "departure_time"],
            msg: "departure_time must be within the next 120 hours",
            type: "value_error",
          },
        ],
      }),
    );
  },
  /** 429 with `Retry-After`. */
  rateLimited429: (
    options: FailureTarget & { readonly retryAfterS?: number } = {},
  ): RequestHandler => {
    const [method, url] = target(options);
    return http[method](url, () =>
      problemResponse(429, "rate_limited", "Too many requests", {
        retryAfterS: options.retryAfterS ?? 3,
      }),
    );
  },
  /** 502 routing_unavailable with `Retry-After`. */
  routingUnavailable502: (options: FailureTarget = {}): RequestHandler => {
    const [method, url] = target(options);
    return http[method](url, () =>
      problemResponse(502, "routing_unavailable", "Routing provider unavailable", {
        retryAfterS: 5,
      }),
    );
  },
  /** The request never reaches a server (offline). */
  networkFailure: (options: FailureTarget = {}): RequestHandler => {
    const [method, url] = target(options);
    return http[method](url, () => HttpResponse.error());
  },
  /** A 2xx whose body is not JSON. */
  malformedJson: (options: FailureTarget = {}): RequestHandler => {
    const [method, url] = target(options);
    return http[method](
      url,
      () =>
        new HttpResponse("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  },
};

/** The cities the geocode mock knows (handy for tests that type a query). */
export { GEOCODE_CATALOG };
