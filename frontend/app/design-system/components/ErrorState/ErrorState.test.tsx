import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { toast, ToastRegion } from "../Toast";
import { ErrorState, errorCopyFor, type ProblemCode } from "./ErrorState";
import { demo } from "./ErrorState.demo";
import { useRetryCountdown } from "./useRetryCountdown";

const CODES = [
  "routing_unavailable",
  "weather_unavailable",
  "weather_capacity_exhausted",
  "rate_limited",
  "no_route_found",
  "same_origin_destination",
  "route_too_long",
  "too_many_checkpoints",
  "departure_out_of_range",
  "plan_not_found",
  "heatmap_failed",
  "offline",
  "generic",
] as const satisfies readonly ProblemCode[];

/** Values for every placeholder the problem copy holds. */
const VALUES = { minutes: 12, interval: 10, seconds: 3 } as const;

/** Renders every state of the demo, the way the `/design` route lays them out. */
function renderDemo(): ReturnType<typeof render> {
  return render(
    <>
      {demo.states.map((state) => (
        <Fragment key={state.id}>{state.node}</Fragment>
      ))}
    </>,
  );
}

/** What the planner does with a 429: the hook ticks, the panel shows the seconds left. */
function RateLimited({ retryAfter }: { readonly retryAfter: number }): ReactElement {
  const remaining = useRetryCountdown(retryAfter);
  return <ErrorState code="rate_limited" retryAfterSeconds={remaining} onRetry={vi.fn()} />;
}

describe("errorCopyFor", () => {
  it.each(CODES)("returns the copy for %s with its placeholders filled in", (code) => {
    expect(errorCopyFor(code, VALUES)).toEqual({
      title: t(`error.${code}.title`, VALUES),
      body: t(`error.${code}.body`, VALUES),
    });
  });

  it("falls back to the generic copy for an unknown or missing code", () => {
    const generic = errorCopyFor("generic");

    expect(errorCopyFor("something_new")).toEqual(generic);
    expect(errorCopyFor(undefined)).toEqual(generic);
    expect(errorCopyFor()).toEqual(generic);
    expect(errorCopyFor("toString")).toEqual(generic);
    expect(errorCopyFor("retry")).toEqual(generic);
  });

  it("needs a value for every placeholder the body holds", () => {
    expect(() => errorCopyFor("rate_limited")).toThrow(/seconds/);
  });
});

describe("ErrorState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Lets Testing Library drain its async queue under vitest fake timers (see Toast.test.tsx).
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
  });

  afterEach(() => {
    act(() => {
      toast.clear();
    });
    vi.useRealTimers();
    // Here, not at the end of a test body: a failing assertion would skip it and leave the stub
    // for the next test.
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it.each(CODES.filter((code) => code !== "rate_limited"))(
    "shows the title and body of %s inside an alert",
    (code) => {
      render(<ErrorState code={code} values={VALUES} />);

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(t(`error.${code}.title`, VALUES));
      expect(alert).toHaveTextContent(t(`error.${code}.body`, VALUES));
    },
  );

  it("shows the generic copy for an unknown code", () => {
    render(<ErrorState code="something_new" />);

    expect(screen.getByRole("alert")).toHaveTextContent(t("error.generic.title"));
    expect(screen.getByRole("alert")).toHaveTextContent(t("error.generic.body"));
  });

  it("lets title and children override the code's copy", () => {
    render(
      <ErrorState code="offline" title="Custom title">
        Custom body
      </ErrorState>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Custom title");
    expect(alert).toHaveTextContent("Custom body");
    expect(alert).not.toHaveTextContent(t("error.offline.title"));
    expect(alert).not.toHaveTextContent(t("error.offline.body"));
  });

  it("merges a caller class name onto the alert", () => {
    render(<ErrorState code="offline" className="from-caller" />);

    expect(screen.getByRole("alert")).toHaveClass("from-caller");
  });

  it("shows no actions and no reference by default", () => {
    render(<ErrorState code="offline" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/Reference/)).not.toBeInTheDocument();
  });

  it("runs the retry and edit callbacks from labelled buttons", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    render(<ErrorState code="offline" onRetry={onRetry} onEdit={onEdit} />);

    await user.click(screen.getByRole("button", { name: t("error.retry") }));
    await user.click(screen.getByRole("button", { name: t("error.editTrip") }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("shows only the actions that have a callback, with custom labels", () => {
    const { rerender } = render(<ErrorState onRetry={vi.fn()} retryLabel="Retry now" />);
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("error.editTrip") })).not.toBeInTheDocument();

    rerender(<ErrorState onEdit={vi.fn()} editLabel="Change trip" />);
    expect(screen.getByRole("button", { name: "Change trip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("error.retry") })).not.toBeInTheDocument();
  });

  it("makes retry the primary action and edit the secondary one", () => {
    render(<ErrorState onRetry={vi.fn()} onEdit={vi.fn()} />);

    expect(screen.getByRole("button", { name: t("error.retry") })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    expect(screen.getByRole("button", { name: t("error.editTrip") })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
  });

  it("shows the request id and copies it, announcing the toast", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <>
        <ErrorState code="offline" requestId="req-abc123" />
        <ToastRegion closeLabel="Close" />
      </>,
    );

    expect(screen.getByText(t("error.reference", { id: "req-abc123" }))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("error.copyReference") }));

    expect(writeText).toHaveBeenCalledWith("req-abc123");
    expect(
      within(screen.getByRole("region")).getByText(t("error.referenceCopied")),
    ).toBeInTheDocument();
  });

  it("toasts the reference's own words when copying it fails", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(
      <>
        <ErrorState code="offline" requestId="req-abc123" />
        <ToastRegion closeLabel="Close" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: t("error.copyReference") }));

    expect(
      within(screen.getByRole("region")).getByText(t("error.referenceCopyFailed")),
    ).toBeInTheDocument();
  });

  it("uses the caller's toast messages for the reference copy", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(
      <>
        <ErrorState
          code="offline"
          requestId="req-abc123"
          referenceCopiedMessage="Reference copied"
          referenceCopyFailedMessage="Could not copy the reference"
        />
        <ToastRegion closeLabel="Close" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: t("error.copyReference") }));

    expect(
      within(screen.getByRole("region")).getByText("Could not copy the reference"),
    ).toBeInTheDocument();
  });

  it("locks retry and shows the seconds left while retryAfterSeconds is above 0", () => {
    const { rerender } = render(
      <ErrorState code="rate_limited" retryAfterSeconds={3} onRetry={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: t("error.retry") })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("error.rate_limited.body", { seconds: 3 }),
    );

    rerender(<ErrorState code="rate_limited" retryAfterSeconds={0} onRetry={vi.fn()} />);

    expect(screen.getByRole("button", { name: t("error.retry") })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("error.rate_limited.body", { seconds: 0 }),
    );
  });

  it("keeps retry enabled when there is no Retry-After", () => {
    render(<ErrorState code="offline" onRetry={vi.fn()} />);

    expect(screen.getByRole("button", { name: t("error.retry") })).toBeEnabled();
  });

  it("keeps the seconds left out of the live announcements", () => {
    render(<ErrorState code="rate_limited" retryAfterSeconds={3} />);

    expect(screen.getByText(t("error.rate_limited.body", { seconds: 3 }))).toHaveAttribute(
      "aria-live",
      "off",
    );
  });

  it("ticks down with useRetryCountdown and unlocks retry at 0", () => {
    render(<RateLimited retryAfter={3} />);
    const retry = screen.getByRole("button", { name: t("error.retry") });
    expect(retry).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("error.rate_limited.body", { seconds: 2 }),
    );
    expect(retry).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("error.rate_limited.body", { seconds: 0 }),
    );
    expect(retry).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Retry and Edit trip are design-system Buttons, whose own tests cover every state. These check
  // that each is wired up in the panel, and that a Retry locked by Retry-After acts as disabled.
  describe("interaction states", () => {
    function newUser(): ReturnType<typeof userEvent.setup> {
      return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    }

    it("wires hover, press and keyboard focus onto the Retry button", async () => {
      const user = newUser();
      render(<ErrorState code="offline" onRetry={vi.fn()} />);
      const retry = screen.getByRole("button", { name: t("error.retry") });

      await expectKeyboardFocusState(user, retry);
      await expectHoverState(user, retry);
      await expectPressedState(user, retry);
    });

    it("wires hover, press and keyboard focus onto the Edit trip button", async () => {
      const user = newUser();
      render(<ErrorState code="offline" onEdit={vi.fn()} />);
      const edit = screen.getByRole("button", { name: t("error.editTrip") });

      await expectKeyboardFocusState(user, edit);
      await expectHoverState(user, edit);
      await expectPressedState(user, edit);
    });

    it("is neither hovered nor pressed while Retry-After locks the Retry button", async () => {
      const user = newUser();
      const onRetry = vi.fn();
      render(<ErrorState code="rate_limited" retryAfterSeconds={3} onRetry={onRetry} />);

      await expectNoPointerStates(user, screen.getByRole("button", { name: t("error.retry") }));
      await user.pointer({ keys: "[/MouseLeft]" });

      expect(onRetry).not.toHaveBeenCalled();
    });

    it("skips the locked Retry button, so the keyboard reaches Edit trip first", async () => {
      const user = newUser();
      render(
        <ErrorState code="rate_limited" retryAfterSeconds={3} onRetry={vi.fn()} onEdit={vi.fn()} />,
      );

      await expectKeyboardFocusState(
        user,
        screen.getByRole("button", { name: t("error.editTrip") }),
      );
    });

    it("responds to the pointer again once the countdown has ended", async () => {
      const user = newUser();
      const { rerender } = render(
        <ErrorState code="rate_limited" retryAfterSeconds={3} onRetry={vi.fn()} />,
      );

      rerender(<ErrorState code="rate_limited" retryAfterSeconds={0} onRetry={vi.fn()} />);

      await expectHoverState(user, screen.getByRole("button", { name: t("error.retry") }));
    });
  });

  it("renders every demo state and runs the demo's retry and edit handlers", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDemo();

    expect(screen.getAllByRole("alert")).toHaveLength(demo.states.length);
    const [firstRetry] = screen.getAllByRole("button", { name: t("error.retry") });
    const [firstEdit] = screen.getAllByRole("button", { name: t("error.editTrip") });
    if (firstRetry === undefined || firstEdit === undefined) {
      throw new Error("The demo renders no retry or edit button");
    }
    await user.click(firstRetry);
    await user.click(firstEdit);

    expect(screen.getByText(t("error.heatmap_failed.title"))).toBeInTheDocument();
  });

  it("has no axe violations, including the demo", async () => {
    const { container } = render(
      <ErrorState
        code="rate_limited"
        retryAfterSeconds={5}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        requestId="req-1"
      />,
    );
    const demoView = renderDemo();

    vi.useRealTimers();
    await expectNoAxeViolations(container);
    await expectNoAxeViolations(demoView.container);
  });
});

describe("ErrorState demo", () => {
  it("gives the generic-copy state the Retry button and request reference its copy points to", () => {
    const generic = demo.states.find((state) => state.id === "unknown-code");
    render(<>{generic?.node}</>);

    expect(screen.getByText(t("error.generic.body"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("error.retry") })).toBeInTheDocument();
    expect(screen.getByText(/req-[0-9a-f]+/)).toBeInTheDocument();
  });
});
