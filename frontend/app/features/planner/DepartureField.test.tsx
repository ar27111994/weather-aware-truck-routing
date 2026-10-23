import { CalendarDate, Time } from "@internationalized/date";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { I18nProvider } from "react-aria";
import { describe, expect, it, vi } from "vitest";

import { NO_DEPARTURE, type Clock, type DepartureDraft } from "./departure";
import { DepartureField } from "./DepartureField";

const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };

function Harness({
  initial = NO_DEPARTURE,
  clock = CLOCK,
  errorMessage,
  onChange,
}: {
  readonly initial?: DepartureDraft;
  readonly clock?: Clock | null;
  readonly errorMessage?: string;
  readonly onChange?: (value: DepartureDraft) => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider locale="en-US">
      <DepartureField
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        clock={clock}
        {...(errorMessage === undefined ? {} : { errorMessage })}
      />
    </I18nProvider>
  );
}

describe("DepartureField", () => {
  it("is a group named Departure with a date and a time", () => {
    render(<Harness />);

    const group = screen.getByRole("group", { name: "Departure" });
    expect(within(group).getByText("Date")).toBeInTheDocument();
    expect(within(group).getByText("Time")).toBeInTheDocument();
  });

  it("says the visitor's time zone in words once there is a clock", () => {
    render(<Harness />);

    expect(
      screen.getByText("Times are in your time zone, Mountain Daylight Time, UTC\u22126."),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Departure" })).toHaveAccessibleDescription(
      /Mountain Daylight Time/u,
    );
  });

  it("keeps the caption's line and draws the chips enabled while there is no clock (the prerender)", () => {
    render(<Harness clock={null} />);

    expect(screen.queryByText(/Times are in your time zone/u)).not.toBeInTheDocument();
    for (const name of ["Now", "+3 h", "Tomorrow 06:00"]) {
      // A disabled button fires no click, so the gate could not record a press made before the
      // planner's code arrived (R4-08); the press is replayed when the clock is there.
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("does nothing for a chip that is pressed while there is no clock, and works once there is one", async () => {
    const onChange = vi.fn<(value: DepartureDraft) => void>();
    const user = userEvent.setup();
    const { rerender } = render(<Harness clock={null} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "+3 h" }));
    expect(onChange).not.toHaveBeenCalled();

    rerender(<Harness clock={CLOCK} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "+3 h" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Now", "2026-10-20", "08:00:00"],
    ["+3 h", "2026-10-20", "11:00:00"],
    ["Tomorrow 06:00", "2026-10-21", "06:00:00"],
  ])("sets date and time with the %s chip", async (chip, date, time) => {
    const onChange = vi.fn<(value: DepartureDraft) => void>();
    render(<Harness onChange={onChange} />);

    await userEvent.setup().click(screen.getByRole("button", { name: chip }));

    const [value] = onChange.mock.calls[0] ?? [];
    expect([value?.date?.toString(), value?.time?.toString()]).toEqual([date, time]);
  });

  it("shows a departure it was given in the date and time segments", () => {
    render(<Harness initial={{ date: new CalendarDate(2026, 10, 22), time: new Time(14, 15) }} />);

    const group = screen.getByRole("group", { name: "Departure" });
    expect(
      within(group)
        .getAllByRole("spinbutton")
        .map((segment) => segment.textContent),
    ).toEqual(expect.arrayContaining(["10", "22", "2026", "2", "15", "PM"]));
  });

  it("reports a typed date and a typed time", async () => {
    const onChange = vi.fn<(value: DepartureDraft) => void>();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Departure" });
    const segments = within(group).getAllByRole("spinbutton");

    const [month, day, year, hour, minute, period] = segments;
    for (const [segment, digits] of [
      [month, "10"],
      [day, "21"],
      [year, "2026"],
      [hour, "9"],
      [minute, "30"],
    ] as const) {
      if (segment === undefined) throw new Error("missing segment");
      await user.click(segment);
      await user.keyboard(digits);
    }
    if (period === undefined) throw new Error("missing period");
    await user.click(period);
    await user.keyboard("A");

    const last = onChange.mock.calls.at(-1)?.[0];
    expect([last?.date?.toString(), last?.time?.toString()]).toEqual(["2026-10-21", "09:30:00"]);
  });

  it("reports the time as empty once its segments are emptied, and keeps the date", async () => {
    const onChange = vi.fn<(value: DepartureDraft) => void>();
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ date: new CalendarDate(2026, 10, 22), time: new Time(14, 15) }}
        onChange={onChange}
      />,
    );
    const segments = within(screen.getByRole("group", { name: "Departure" })).getAllByRole(
      "spinbutton",
    );
    const hour = segments[3];
    if (hour === undefined) throw new Error("missing segment");

    await user.click(hour);
    await user.keyboard("{Backspace}{Backspace}");
    await user.tab();
    await user.keyboard("{Backspace}{Backspace}");
    await user.tab();
    await user.keyboard("{Backspace}");

    const last = onChange.mock.calls.at(-1)?.[0];
    expect([last?.date?.toString(), last?.time]).toEqual(["2026-10-22", null]);
  });

  it("shows the error with the date and marks both fields invalid", () => {
    render(<Harness errorMessage="Choose a departure from now up to 5 days ahead." />);

    expect(screen.getByText("Choose a departure from now up to 5 days ahead.")).toBeInTheDocument();
    for (const segment of within(screen.getByRole("group", { name: "Departure" })).getAllByRole(
      "spinbutton",
    )) {
      expect(segment).toHaveAttribute("aria-invalid", "true");
    }
  });
});
