import { CalendarDate, CalendarDateTime } from "@internationalized/date";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, useState, type ReactElement } from "react";
import { I18nProvider, type DateValue } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { t } from "../../foundation/strings";
import { DatePicker, type DatePickerProps } from "./DatePicker";
import { demo } from "./DatePicker.demo";

const label = t("form.departure.label");

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

function renderPicker(locale: string, props: Partial<DatePickerProps> = {}): void {
  render(
    <I18nProvider locale={locale}>
      <DatePicker label={label} {...props} />
    </I18nProvider>,
  );
}

function field(): HTMLElement {
  return screen.getByRole("group", { name: label });
}

/** The first of several matches; React Aria renders a visually hidden twin of the Next button. */
function first(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (element === undefined) {
    throw new Error("Expected at least one matching element");
  }
  return element;
}

function toggle(): HTMLElement {
  return screen.getByRole("button", { name: /calendar/i, hidden: true });
}

describe("DatePicker", () => {
  it("names the field group by its label and shows a calendar button", () => {
    renderPicker("en-US");

    expect(field()).toBeInTheDocument();
    expect(toggle()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("orders segments by locale: en-US month first, en-GB day first", () => {
    renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21) });
    const us = within(field())
      .getAllByRole("spinbutton")
      .map((s) => s.getAttribute("aria-label"));
    expect(us[0]).toMatch(/month/i);
  });

  it("orders en-GB segments day first", () => {
    renderPicker("en-GB", { defaultValue: new CalendarDate(2026, 10, 21) });

    expect(within(field()).getAllByRole("spinbutton")[0]).toHaveAccessibleName(/day/i);
  });

  it("shows date and time segments with granularity minute: 12-hour in en-US, 24-hour in en-GB", () => {
    const value = new CalendarDateTime(2026, 10, 21, 14, 30);
    const { unmount } = render(
      <I18nProvider locale="en-US">
        <DatePicker label={label} granularity="minute" defaultValue={value} />
      </I18nProvider>,
    );
    expect(within(field()).getByRole("spinbutton", { name: /AM\/PM/i })).toHaveTextContent("PM");
    unmount();

    renderPicker("en-GB", { granularity: "minute", defaultValue: value });

    expect(within(field()).getByRole("spinbutton", { name: /hour/i })).toHaveTextContent("14");
    expect(within(field()).queryByRole("spinbutton", { name: /AM\/PM/i })).toBeNull();
  });

  it("puts the description (time-zone caption) in the accessible description", () => {
    renderPicker("en-US", { description: "Times are in your time zone." });

    expect(field()).toHaveAccessibleDescription(
      expect.stringContaining("Times are in your time zone."),
    );
  });

  it("renders the quickChips slot under the field and keeps them separate from the toggle", async () => {
    const user = userEvent.setup();
    const onChip = vi.fn();
    renderPicker("en-US", {
      quickChips: <button onClick={onChip}>{t("form.departure.chips.now")}</button>,
    });

    await user.click(screen.getByRole("button", { name: t("form.departure.chips.now") }));

    expect(onChip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("types into segments and reports the date", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker("en-US", { onChange });

    await user.click(first(within(field()).getAllByRole("spinbutton")));
    await user.keyboard("10212026");

    expect(onChange).toHaveBeenLastCalledWith(new CalendarDate(2026, 10, 21));
  });

  it("opens the calendar by button and picks a date by click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21), onChange });

    await user.click(toggle());
    const dialog = screen.getByRole("dialog");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.click(within(dialog).getByRole("button", { name: /Thursday, October 22, 2026/ }));

    expect(onChange).toHaveBeenCalledWith(new CalendarDate(2026, 10, 22));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the calendar by keyboard and picks a date with arrows and Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21), onChange });

    toggle().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}{Enter}");

    expect(onChange).toHaveBeenCalledWith(new CalendarDate(2026, 10, 22));
  });

  it("moves between months with the header buttons", async () => {
    const user = userEvent.setup();
    renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21) });

    await user.click(toggle());
    const dialog = screen.getByRole("dialog");
    await user.click(first(within(dialog).getAllByRole("button", { name: "Next" })));
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent("November 2026");
    await user.click(within(dialog).getByRole("button", { name: "Previous" }));

    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent("October 2026");
  });

  it("starts the week by the locale: Sunday in en-US, Monday in en-GB", async () => {
    const user = userEvent.setup();
    renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21) });
    await user.click(toggle());
    expect(
      within(screen.getByRole("dialog")).getAllByRole("button", { name: / 2026$/ })[0],
    ).toHaveAccessibleName(/^Sunday/);
    await user.keyboard("{Escape}");
  });

  it("starts en-GB weeks on Monday", async () => {
    const user = userEvent.setup();
    renderPicker("en-GB", { defaultValue: new CalendarDate(2026, 10, 21) });

    await user.click(toggle());

    expect(
      within(screen.getByRole("dialog")).getAllByRole("button", { name: / 2026$/ })[0],
    ).toHaveAccessibleName(/^Monday/);
  });

  it("disables dates outside min and max and unavailable dates", async () => {
    const user = userEvent.setup();
    renderPicker("en-US", {
      defaultValue: new CalendarDate(2026, 10, 21),
      minValue: new CalendarDate(2026, 10, 20),
      maxValue: new CalendarDate(2026, 10, 25),
      isDateUnavailable: (date: DateValue) => date.day === 23,
    });

    await user.click(toggle());
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByRole("button", { name: /October 19, 2026/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: /October 26, 2026/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: /October 23, 2026/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: /October 24, 2026/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("shows the error and the invalid state when the value is out of range", () => {
    renderPicker("en-US", {
      defaultValue: new CalendarDate(2026, 10, 30),
      maxValue: new CalendarDate(2026, 10, 25),
      errorMessage: t("form.departure.error.range"),
    });

    expect(screen.getByText(t("form.departure.error.range"))).toBeVisible();
    expect(within(field()).getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
  });

  it("shows no error while valid, and shows it when told invalid", () => {
    const { unmount } = render(<DatePicker label={label} errorMessage="Bad date" />);
    expect(screen.queryByText("Bad date")).not.toBeInTheDocument();
    unmount();

    render(<DatePicker label={label} isInvalid errorMessage="Bad date" />);

    expect(screen.getByText("Bad date")).toBeVisible();
  });

  it("works controlled", async () => {
    const user = userEvent.setup();
    function Controlled(): ReactElement {
      const [value, setValue] = useState<DateValue | null>(new CalendarDate(2026, 10, 21));
      return (
        <I18nProvider locale="en-US">
          <DatePicker label={label} value={value} onChange={setValue} />
        </I18nProvider>
      );
    }
    render(<Controlled />);

    await user.click(toggle());
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /October 24, 2026/ }),
    );

    expect(within(field()).getAllByRole("spinbutton")[1]).toHaveTextContent("24");
  });

  it("does not open while disabled or read only", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DatePicker label={label} isDisabled />);
    expect(toggle()).toBeDisabled();
    unmount();

    render(<DatePicker label={label} isReadOnly />);
    await user.click(toggle());

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("marks required", () => {
    render(<DatePicker label={label} isRequired />);

    expect(within(field()).getAllByRole("spinbutton")[0]).toHaveAttribute("aria-required", "true");
  });

  it("honours firstDayOfWeek", async () => {
    const user = userEvent.setup();
    renderPicker("en-US", { firstDayOfWeek: "mon" });

    await user.click(toggle());

    expect(
      within(screen.getByRole("dialog")).getAllByRole("button", { name: / 2026$/ })[0],
    ).toHaveAccessibleName(/^Monday/);
  });

  describe("accessibility (axe)", () => {
    it("has no violations closed, in several states", async () => {
      const { container } = render(
        <>
          <DatePicker label="One" />
          <DatePicker label="Two" description="Hint" quickChips={<span>Chips</span>} />
          <DatePicker label="Three" isInvalid errorMessage="Bad" />
          <DatePicker label="Four" isDisabled />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it("has no violations with the calendar open", async () => {
      const user = userEvent.setup();
      renderPicker("en-US", { defaultValue: new CalendarDate(2026, 10, 21) });

      await user.click(toggle());

      await expectNoAxeViolations(screen.getByRole("dialog"));
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = renderDemo();

      await expectNoAxeViolations(container);
    });
  });

  describe("demo", () => {
    it("lets the quick chips set the value", async () => {
      const user = userEvent.setup();
      renderDemo();

      await user.click(screen.getByRole("button", { name: t("form.departure.chips.plus3h") }));
      await user.click(screen.getByRole("button", { name: t("form.departure.chips.now") }));
      await user.click(
        screen.getByRole("button", { name: t("form.departure.chips.tomorrow0600") }),
      );

      expect(screen.getAllByRole("spinbutton", { name: /hour/i })[0]).toHaveTextContent("6");
    });
  });
});
