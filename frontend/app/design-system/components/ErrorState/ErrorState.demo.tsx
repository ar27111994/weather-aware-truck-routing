import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { ErrorState } from "./ErrorState";

/** Stands in for the retry and edit handlers the planner wires in. */
function noop(): void {
  return undefined;
}

/**
 * What the `/design` route renders for ErrorState. The Retry-After value is pinned (a ticking one
 * would change the pixels between two screenshots); `useRetryCountdown` is what makes it tick.
 */
export const demo: Demo = {
  name: "ErrorState",
  description: "A failed request with problem-code copy, retry and a request reference.",
  states: [
    {
      id: "routing-unavailable",
      title: "Routing unavailable, with actions and request reference",
      node: (
        <ErrorState
          code="routing_unavailable"
          onRetry={noop}
          onEdit={noop}
          requestId="req-7f3a91"
        />
      ),
    },
    {
      id: "rate-limited",
      title: "Rate limited: retry stays locked while Retry-After is above 0 (5 s left)",
      node: <ErrorState code="rate_limited" retryAfterSeconds={5} onRetry={noop} />,
    },
    {
      id: "unknown-code",
      title: "A code without its own copy falls back to the generic message",
      node: <ErrorState code="something_new" />,
    },
    {
      id: "custom-copy",
      title: "Caller-supplied title and body",
      node: (
        <ErrorState title={t("error.heatmap_failed.title")} onEdit={noop}>
          {t("error.heatmap_failed.body")}
        </ErrorState>
      ),
    },
  ],
};
