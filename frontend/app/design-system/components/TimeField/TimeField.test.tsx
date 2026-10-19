import { Time } from "@internationalized/date";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { I18nProvider, type TimeValue } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { TimeField, type TimeFieldProps } from "./TimeField";
import TimeFieldDemo from "./TimeField.demo";

const label = copy.form.departure.timeLabel;

function renderField(locale: string, props: Partial<TimeFieldProps> = {}): void {
  render(
    <I18nProvider locale={locale}>
      <TimeField label={label} {...props} />
    </I18nProvider>,
  );
}

function group(): HTMLElement {
  return screen.getByRole("group", { name: label });
}

describe("TimeField", () => {
  it("names the group by its label and exposes hour and minute segments", () => {
    renderField("en-US", { defaultValue: new Time(14, 30) });

    expect(within(group()).getByRole("spinbutton", { name: /hour/i })).toHaveTextContent("2");
    expect(within(group()).getByRole("spinbutton", { name: /minute/i })).toHaveTextContent("30");
  });

  it("follows en-US: a 12-hour clock with an AM/PM segment", () => {
    renderField("en-US", { defaultValue: new Time(14, 30) });

    expect(within(group()).getByRole("spinbutton", { name: /AM\/PM/i })).toHaveTextContent("PM");
  });

  it("follows en-GB: a 24-hour clock without an AM/PM segment", () => {
    renderField("en-GB", { defaultValue: new Time(14, 30) });

    expect(within(group()).queryByRole("spinbutton", { name: /AM\/PM|day period/i })).toBeNull();
    expect(within(group()).getByRole("spinbutton", { name: /hour/i })).toHaveTextContent("14");
  });

  it("describes the group with its hint", () => {
    renderField("en-US", { description: "Local time" });

    expect(group()).toHaveAccessibleDescription("Local time");
  });

  it("types into segments and reports the time", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField("en-GB", { defaultValue: new Time(8, 0), onChange });

    await user.click(within(group()).getByRole("spinbutton", { name: /hour/i }));
    await user.keyboard("0645");

    expect(onChange).toHaveBeenLastCalledWith(new Time(6, 45));
  });

  it("steps a segment with the arrow keys", async () => {
    const user = userEvent.setup();
    renderField("en-GB", { defaultValue: new Time(8, 0) });
    const hour = within(group()).getByRole("spinbutton", { name: /hour/i });

    await user.click(hour);
    await user.keyboard("{ArrowUp}");

    expect(hour).toHaveTextContent("9");
  });

  it("shows the error while invalid, including a time outside min and max", () => {
    renderField("en-GB", {
      defaultValue: new Time(5, 0),
      minValue: new Time(6, 0),
      maxValue: new Time(20, 0),
      errorMessage: copy.form.departure.error.range,
    });

    expect(screen.getByText(copy.form.departure.error.range)).toBeVisible();
    expect(group()).toHaveAccessibleDescription(
      expect.stringContaining(copy.form.departure.error.range),
    );
    expect(within(group()).getByRole("spinbutton", { name: /hour/i })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("shows the error when told invalid, and nothing while valid", () => {
    renderField("en-GB", { defaultValue: new Time(8, 0), errorMessage: "Bad time" });
    expect(screen.queryByText("Bad time")).not.toBeInTheDocument();
  });

  it("shows the error when told invalid", () => {
    renderField("en-GB", { isInvalid: true, errorMessage: "Bad time" });

    expect(screen.getByText("Bad time")).toBeVisible();
  });

  it("honours granularity", () => {
    renderField("en-GB", { defaultValue: new Time(8, 0, 5), granularity: "second" });

    expect(within(group()).getByRole("spinbutton", { name: /second/i })).toBeInTheDocument();
  });

  it("works controlled", async () => {
    const user = userEvent.setup();
    function Controlled(): ReactElement {
      const [value, setValue] = useState<TimeValue | null>(new Time(8, 0));
      return (
        <I18nProvider locale="en-GB">
          <TimeField label={label} value={value} onChange={setValue} />
        </I18nProvider>
      );
    }
    render(<Controlled />);
    const hour = within(group()).getByRole("spinbutton", { name: /hour/i });

    await user.click(hour);
    await user.keyboard("{ArrowDown}");

    expect(hour).toHaveTextContent("7");
  });

  it("cannot be edited while disabled", async () => {
    const user = userEvent.setup();
    renderField("en-GB", { defaultValue: new Time(8, 0), isDisabled: true });
    const hour = within(group()).getByRole("spinbutton", { name: /hour/i });

    await user.click(hour);
    await user.keyboard("{ArrowUp}");

    expect(hour).toHaveTextContent("8");
    expect(hour).toHaveAttribute("aria-disabled", "true");
  });

  it("cannot be edited while read only", async () => {
    const user = userEvent.setup();
    renderField("en-GB", { defaultValue: new Time(8, 0), isReadOnly: true });
    const hour = within(group()).getByRole("spinbutton", { name: /hour/i });

    await user.click(hour);
    await user.keyboard("{ArrowUp}");

    expect(hour).toHaveTextContent("8");
    expect(hour).toHaveAttribute("aria-readonly", "true");
  });

  it("marks required", () => {
    renderField("en-GB", { isRequired: true });

    expect(within(group()).getByRole("spinbutton", { name: /hour/i })).toHaveAttribute(
      "aria-required",
      "true",
    );
  });

  describe("accessibility (axe)", () => {
    it("has no violations in several states", async () => {
      const { container } = render(
        <I18nProvider locale="en-US">
          <TimeField label="One" />
          <TimeField label="Two" description="Hint" defaultValue={new Time(9, 0)} />
          <TimeField label="Three" isInvalid errorMessage="Bad" />
          <TimeField label="Four" isDisabled />
          <TimeField label="Five" isReadOnly />
        </I18nProvider>,
      );

      await expectNoAxeViolations(container);
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = render(<TimeFieldDemo />);

      await expectNoAxeViolations(container);
    });
  });
});
