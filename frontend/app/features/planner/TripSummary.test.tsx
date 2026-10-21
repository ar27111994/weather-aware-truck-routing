import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "react-aria";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastRegion } from "../../design-system/components/Toast";
import { planFor } from "../../../test/plans";
import { TripSummary } from "./TripSummary";

const LINK = "https://haulcast.example/?plan=pln_00000000000000000000000000";

function renderSummary(locale: string, onEdit = (): void => undefined): void {
  render(
    <I18nProvider locale={locale}>
      <TripSummary
        plan={planFor("calm", { sampling_interval_mi: 50 })}
        onEdit={onEdit}
        link={LINK}
      />
      <ToastRegion closeLabel="Dismiss message" />
    </I18nProvider>,
  );
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("TripSummary", () => {
  it("says in one line what was planned, in the visitor's own clock and number format", () => {
    renderSummary("en-US");

    const line = screen.getByText(/^Salt Lake City, Utah, United States to Denver/u);
    expect(line).toHaveTextContent(/, 38,000 lb, every 50 mi$/u);
    expect(line.textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/u);
  });

  it("uses the 24-hour clock and the grouping of a locale that has one", () => {
    renderSummary("en-GB");

    const line = screen.getByText(/^Salt Lake City, Utah, United States to Denver/u);
    expect(line.textContent).toMatch(/\b\d{2}:\d{2}\b/u);
    expect(line.textContent).not.toMatch(/AM|PM/u);
  });

  it("opens the form again", async () => {
    const onEdit = vi.fn<() => void>();
    renderSummary("en-US", onEdit);

    await userEvent.setup().click(screen.getByRole("button", { name: "Edit trip" }));

    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("copies the address that restores the plan, and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSummary("en-US");

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });
});
