import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { I18nProvider } from "react-aria";
import { describe, expect, it, vi } from "vitest";

import { LoadField } from "./LoadField";

function Harness({
  initial = Number.NaN,
  locale = "en-US",
  errorMessage,
  onChange,
}: {
  readonly initial?: number;
  readonly locale?: string;
  readonly errorMessage?: string;
  readonly onChange?: (pounds: number) => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider locale={locale}>
      <LoadField
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        {...(errorMessage === undefined ? {} : { errorMessage })}
      />
    </I18nProvider>
  );
}

describe("LoadField", () => {
  it("is a labelled field in pounds with steppers and the common loads", () => {
    render(<Harness />);

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Decrease load by 1,000 lb Load weight" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Increase load by 1,000 lb Load weight" }),
    ).toBeInTheDocument();
    const presets = screen.getByRole("group", { name: "Common loads" });
    expect(
      within(presets)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Empty", "20,000", "38,000", "45,000", "80,000"]);
  });

  it("says no load rule escalates while the field is empty, and offers no gross weight", () => {
    render(<Harness />);

    expect(
      screen.getByText("Wind rules only. No load escalation at this weight."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gross weight/u)).not.toBeInTheDocument();
  });

  it.each([
    [20_000, "Wind rules only. No load escalation at this weight.", "55,000 lb"],
    [38_000, "Load rule LR-2 applies: wind from 45 mph becomes No Travel.", "73,000 lb"],
    [
      45_000,
      "Load rules LR-2 and LR-3 apply: wind from 35 mph becomes Severe, from 45 mph No Travel.",
      "80,000 lb",
    ],
  ])(
    "at %i lb tells which load rules apply and the gross weight routing uses",
    (load, rules, gross) => {
      render(<Harness initial={load} />);

      expect(
        screen.getByText(new RegExp(rules.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")),
      ).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`gross weight of ${gross}`, "u"))).toBeInTheDocument();
    },
  );

  it("sets the load of a preset", async () => {
    const onChange = vi.fn<(pounds: number) => void>();
    render(<Harness onChange={onChange} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "38,000" }));

    expect(onChange).toHaveBeenLastCalledWith(38_000);
    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("38,000");
  });

  it("steps by 1,000 lb with the plus and minus buttons", async () => {
    const user = userEvent.setup();
    render(<Harness initial={38_000} />);

    await user.click(screen.getByRole("button", { name: "Increase load by 1,000 lb Load weight" }));
    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("39,000");
    await user.click(screen.getByRole("button", { name: "Decrease load by 1,000 lb Load weight" }));
    await user.click(screen.getByRole("button", { name: "Decrease load by 1,000 lb Load weight" }));

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("37,000");
  });

  it("reports a typed load once the field is left, and clamps it to the range", async () => {
    const onChange = vi.fn<(pounds: number) => void>();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.type(screen.getByRole("textbox", { name: /Load weight/u }), "90000");
    await user.tab();

    expect(onChange).toHaveBeenLastCalledWith(80_000);
  });

  // R4-06 / R3-02: typing allows any integer. A load of 30,400 lb is over the 30,000 lb that
  // switches on load rule LR-2, and rounding it to 30,000 lb would switch the rule off.
  it("keeps a typed load that is not a multiple of 1,000 lb and applies the load rules to it", async () => {
    const onChange = vi.fn<(pounds: number) => void>();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.type(screen.getByRole("textbox", { name: /Load weight/u }), "30400");
    await user.tab();

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("30,400");
    expect(onChange).toHaveBeenLastCalledWith(30_400);
    expect(
      screen.getByText(/Load rule LR-2 applies: wind from 45 mph becomes No Travel./u),
    ).toBeInTheDocument();
    expect(screen.getByText(/gross weight of 65,400 lb/u)).toBeInTheDocument();
  });

  it("shows a load from the address as it is, even when it is not a multiple of 1,000 lb", () => {
    render(<Harness initial={30_400} />);

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("30,400");
  });

  it("steps by 1,000 lb from a typed load that is not a multiple of 1,000 lb", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: /Load weight/u });

    await user.type(input, "30400");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Increase load by 1,000 lb Load weight" }));
    expect(input).toHaveValue("31,400");
    await user.click(screen.getByRole("button", { name: "Decrease load by 1,000 lb Load weight" }));
    await user.click(screen.getByRole("button", { name: "Decrease load by 1,000 lb Load weight" }));

    expect(input).toHaveValue("29,400");
    expect(
      screen.getByText("Wind rules only. No load escalation at this weight.", { exact: false }),
    ).toBeInTheDocument();
  });

  // R4-09: the field and the hint beside it follow the visitor's number format.
  it("writes the field and the gross weight beside it in the visitor's number format", () => {
    render(<Harness initial={38_000} locale="de-DE" />);

    expect(screen.getByRole("textbox", { name: /Load weight/u })).toHaveValue("38.000");
    expect(screen.getByText(/gross weight of 73[.]000 lb/u)).toBeInTheDocument();
  });

  it("shows an error tied to the field and marks it invalid", () => {
    render(<Harness errorMessage="Enter the load weight in pounds." />);

    const input = screen.getByRole("textbox", { name: /Load weight/u });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(/Enter the load weight in pounds\./u);
  });
});
