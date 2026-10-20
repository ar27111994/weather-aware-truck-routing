import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { DENVER, DEPARTURE } from "../../../../test/timeline-clock";
import { TIMELINE_HOURS, TimelineReadout, TimelineSlider } from "./TimelineSlider";

describe("TimelineSlider", () => {
  it("is a slider from 0 to 48 hours named Forecast time", () => {
    render(<TimelineSlider {...DENVER} />);

    const input = screen.getByRole("slider", { name: "Forecast time" });
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", String(TIMELINE_HOURS));
    expect(input).toHaveAttribute("step", "1");
    expect(input).toHaveValue("0");
  });

  it("reads the departure as a weekday and time with the word departure", () => {
    render(<TimelineSlider {...DENVER} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 2:00 PM, departure");
  });

  it("reads a later hour as weekday, time and the offset in hours", () => {
    render(<TimelineSlider {...DENVER} defaultValue={6} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 8:00 PM, +6 hours");
  });

  it("crosses midnight into the next weekday", () => {
    render(<TimelineSlider {...DENVER} defaultValue={12} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Wed 2:00 AM, +12 hours");
  });

  it("follows the locale: 24-hour for en-GB", () => {
    render(
      <TimelineSlider
        departure={DEPARTURE}
        timeZone="America/Denver"
        locale="en-GB"
        defaultValue={6}
      />,
    );

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 20:00, +6 hours");
  });

  it("says one hour in the singular (R1-08)", () => {
    render(<TimelineSlider {...DENVER} defaultValue={1} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 3:00 PM, +1 hour");
  });

  it("builds no Intl.DateTimeFormat while the value changes (R1-06)", async () => {
    const user = userEvent.setup();
    render(<TimelineSlider {...DENVER} />);
    screen.getByRole("slider").focus();
    const construct = vi.spyOn(Intl, "DateTimeFormat");

    await user.keyboard("{ArrowRight}{ArrowRight}{PageUp}");

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 10:00 PM, +8 hours");
    expect(construct).not.toHaveBeenCalled();
  });

  it("keeps its formatters when the parent passes a new Date for the same departure (R1-06)", () => {
    const props = { timeZone: "America/Denver", locale: "en-US" } as const;
    const { rerender } = render(<TimelineSlider {...props} departure={new Date(DEPARTURE)} />);
    const construct = vi.spyOn(Intl, "DateTimeFormat");

    rerender(<TimelineSlider {...props} departure={new Date(DEPARTURE)} />);

    expect(construct).not.toHaveBeenCalled();
  });

  it("builds new formatters when the zone changes", () => {
    const { rerender } = render(<TimelineSlider {...DENVER} defaultValue={6} />);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Tue 8:00 PM, +6 hours");

    rerender(<TimelineSlider {...DENVER} timeZone="Asia/Tokyo" defaultValue={6} />);

    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Wed 11:00 AM, +6 hours");
  });

  it("uses the user's zone and locale when none are given", () => {
    render(<TimelineSlider departure={DEPARTURE} />);

    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toMatch(/, departure$/);
  });

  it("moves one hour with the arrows and six with Page Up and Page Down", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimelineSlider {...DENVER} onChange={onChange} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("slider")).toHaveValue("1");

    await user.keyboard("{PageUp}");
    expect(screen.getByRole("slider")).toHaveValue("7");
    expect(onChange).toHaveBeenLastCalledWith(7);

    await user.keyboard("{PageDown}");
    expect(screen.getByRole("slider")).toHaveValue("1");

    await user.keyboard("{End}");
    expect(screen.getByRole("slider")).toHaveValue("48");
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Thu 2:00 PM, +48 hours");
  });

  it("labels every sixth hour except +0, with the last label hung inward from its tick", () => {
    const { container } = render(<TimelineSlider {...DENVER} />);

    const labels = Array.from(container.querySelectorAll("svg text"))
      .filter((node) => node.textContent.startsWith("+"))
      .map((node) => [node.textContent, node.getAttribute("text-anchor")]);

    expect(labels).toEqual([
      ["+6 h", "middle"],
      ["+12 h", "middle"],
      ["+18 h", "middle"],
      ["+24 h", "middle"],
      ["+30 h", "middle"],
      ["+36 h", "middle"],
      ["+42 h", "middle"],
      ["+48 h", "end"],
    ]);
  });

  it("draws a tick for every hour and marks local midnights with the weekday", () => {
    const { container } = render(<TimelineSlider {...DENVER} />);

    const ticks = container.querySelectorAll("svg[data-scale='ticks'] line");
    expect(ticks).toHaveLength(TIMELINE_HOURS + 1);
    const days = Array.from(container.querySelectorAll("svg[data-scale='days'] text")).map(
      (node) => node.textContent,
    );
    expect(days).toEqual(["Wed", "Thu"]);
  });

  it("puts the first midnight at 10 hours after a 14:00 departure, as a percentage of the track", () => {
    const { container } = render(<TimelineSlider {...DENVER} />);

    const rule = container.querySelector("svg[data-scale='days'] line");
    expect(rule).toHaveAttribute("x1", "20.8333%");
  });

  it("hides the decorative scale from assistive technology and writes no inline style of its own", () => {
    const { container } = render(<TimelineSlider {...DENVER} />);

    for (const svg of container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).not.toHaveAttribute("style");
    }
  });

  it("can be shorter than 48 hours", () => {
    render(<TimelineSlider {...DENVER} hours={12} />);

    expect(screen.getByRole("slider")).toHaveAttribute("max", "12");
  });

  it("accepts a Date for the departure and another accessible name", () => {
    render(
      <TimelineSlider
        departure={new Date(DEPARTURE)}
        timeZone="America/Denver"
        locale="en-US"
        label="Weather time"
      />,
    );

    expect(screen.getByRole("slider", { name: "Weather time" })).toBeInTheDocument();
  });

  it("is controlled by value and reports changes and the settled position", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(<TimelineSlider {...DENVER} value={3} onChange={onChange} onChangeEnd={onChangeEnd} />);
    screen.getByRole("slider").focus();

    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith(4);
    expect(onChangeEnd).toHaveBeenCalledWith(4);
    expect(screen.getByRole("slider")).toHaveValue("3");
  });

  it("merges a caller class name", () => {
    const { container } = render(<TimelineSlider {...DENVER} className="custom" />);

    expect(container.firstElementChild).toHaveClass("custom");
  });

  describe("while the frames are not ready", () => {
    it("swaps the slider for a busy skeleton and a polite caption", () => {
      const { container } = render(<TimelineSlider {...DENVER} isLoading className="custom" />);

      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
      expect(container.firstElementChild).toHaveClass("custom");
      expect(screen.getByRole("status")).toHaveTextContent("Preparing 49 forecast hours");
    });

    it("has no accessibility violations", async () => {
      const { container } = render(<TimelineSlider {...DENVER} isLoading />);

      await expectNoAxeViolations(container);
    });
  });

  it("has no accessibility violations once ready", async () => {
    const { container } = render(<TimelineSlider {...DENVER} defaultValue={6} />);

    await expectNoAxeViolations(container);
  });
});

describe("TimelineReadout", () => {
  it("shows local time with the zone and the offset under it, hidden from assistive technology", () => {
    const { container } = render(<TimelineReadout {...DENVER} hour={6} />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container).toHaveTextContent("Tue 8:00 PM MDT");
    expect(container).toHaveTextContent("+6 h");
  });

  it("builds no Intl.DateTimeFormat when only the hour changes (R1-06)", () => {
    const { container, rerender } = render(<TimelineReadout {...DENVER} hour={0} />);
    const construct = vi.spyOn(Intl, "DateTimeFormat");

    rerender(<TimelineReadout {...DENVER} hour={1} />);

    expect(container).toHaveTextContent("Tue 3:00 PM MDT");
    expect(construct).not.toHaveBeenCalled();
  });

  it("writes a negative zone offset with the minus sign, not a hyphen (R1-09)", () => {
    const { container } = render(<TimelineReadout {...DENVER} locale="en-GB" hour={0} />);

    expect(container).toHaveTextContent("Tue 14:00 GMT\u22126");
  });

  it("merges a caller class name", () => {
    const { container } = render(<TimelineReadout {...DENVER} hour={0} className="custom" />);

    expect(container.firstElementChild).toHaveClass("custom");
  });
});
