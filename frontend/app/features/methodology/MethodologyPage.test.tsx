import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../test/axe";
import { closeUpperEdge, relabel, validRules } from "../../../test/risk-rules-variants";
import type { RiskRules } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import { EtaDiagram } from "./EtaDiagram";
import { FAQ_IDS, faqAnswer, faqQuestion } from "./rules-text";
import {
  ASSUMPTION_IDS,
  CHOICE_IDS,
  MethodologyPage,
  SECTIONS,
  SOURCE_IDS,
} from "./MethodologyPage";

// The whole page is scanned by axe, and a machine running other jobs can take longer than 5 s over it.
vi.setConfig({ testTimeout: 20_000 });

function changed(edit: (rules: RiskRules) => void): RiskRules {
  const copy = structuredClone(RISK_RULES);
  edit(copy);
  return copy;
}

describe("MethodologyPage", () => {
  it("has the one h1 of the page and its lead", () => {
    render(<MethodologyPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "How Haulcast scores weather risk" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText(/^Every checkpoint is scored with the weather forecast/u),
    ).toBeInTheDocument();
  });

  it("has a section for each of its links, and each link goes to its section", () => {
    render(<MethodologyPage />);

    const nav = screen.getByRole("navigation", { name: "On this page" });
    for (const section of SECTIONS) {
      const link = within(nav).getByRole("link", { name: t(section.title) });
      expect(link).toHaveAttribute("href", `#${section.id}`);
      const heading = screen.getByRole("heading", { level: 2, name: t(section.title) });
      expect(heading).toHaveAttribute("id", section.id);
    }
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(SECTIONS.length);
  });

  it("renders the risk table from the rules it is given, and follows them", () => {
    const rules = changed((copy) => {
      const [low, moderate] = copy.factors.wind.bands;
      if (low === undefined || moderate === undefined) throw new Error("wind has no bands");
      low.max_exclusive = 30;
      moderate.min_inclusive = 30;
    });
    const { rerender } = render(<MethodologyPage />);
    const table = screen.getByRole("table", { name: "Risk level thresholds by weather factor" });
    expect(within(table).getByRole("rowheader", { name: "Wind (mph)" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "under 25" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "0.50 to 1.00" })).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);

    rerender(<MethodologyPage rules={rules} />);

    expect(within(table).getByRole("cell", { name: "under 30" })).toBeInTheDocument();
    expect(within(table).queryByRole("cell", { name: "under 25" })).not.toBeInTheDocument();
  });

  it("keeps the table in a named region that scrolls instead of clipping", () => {
    render(<MethodologyPage />);

    const region = screen.getByRole("region", { name: "Risk level thresholds by weather factor" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("writes the load rules and the ranking from the rules file", () => {
    render(<MethodologyPage />);

    expect(
      screen.getByText(
        "LR-2: wind from 45 to under 55 mph with a load over 30,000 lb is No Travel.",
      ),
    ).toBeInTheDocument();
    const ranking = screen
      .getByRole("heading", { level: 2, name: "How routes are ranked" })
      .closest("section");
    if (ranking === null) throw new Error("no ranking section");
    expect(
      within(ranking)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Fewest No Travel miles",
      "Most complete weather data",
      "Fewest Severe miles",
      "Fewest High miles",
      "Lowest average risk",
      "Shortest travel time",
    ]);
    expect(within(ranking).getByText(RISK_RULES.ranking.extension_note)).toBeInTheDocument();
  });

  it("leaves out the sentence about the weights a load has to exceed when no rule has one", () => {
    const strict = /does not trigger a rule/u;
    const { unmount } = render(<MethodologyPage />);
    expect(screen.getByText(strict)).toBeInTheDocument();
    unmount();

    render(
      <MethodologyPage
        rules={changed((copy) => {
          for (const rule of copy.load_rules) rule.load_lb_min_exclusive = null;
        })}
      />,
    );

    expect(screen.queryByText(strict)).not.toBeInTheDocument();
  });

  it("changes its ranking note when the rules file does", () => {
    const rules = changed((copy) => {
      copy.ranking.extension_note = "A note written for this test.";
    });

    render(<MethodologyPage rules={rules} />);

    expect(screen.getByText("A note written for this test.")).toBeInTheDocument();
    expect(screen.queryByText(RISK_RULES.ranking.extension_note)).not.toBeInTheDocument();
  });

  it("states where a value on an edge goes in the words of the rules file (RT-F2)", () => {
    const rules = validRules((copy) => {
      closeUpperEdge(copy, "wind", "high");
      relabel(copy, "severe", "Extreme");
    });

    render(<MethodologyPage rules={rules} />);

    expect(
      screen.getByText(
        "Each band includes its lower number. A value exactly on a boundary belongs to the higher " +
          "band, except wind at exactly 45 mph, which stays High, and rain at exactly 1.00 in/hr and " +
          "snow at exactly 3.0 in/hr, which stay Extreme.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Each band includes its lower number, so 25.0 mph is Moderate and 24.9 mph is Low. Wind at " +
          "exactly 45 mph stays High. Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr stay " +
          "Extreme, because the brief calls No Travel anything over those values.",
      ),
    ).toBeInTheDocument();
  });

  it("explains every deliberate choice, each with what it does and why", () => {
    render(<MethodologyPage />);

    expect(CHOICE_IDS).toHaveLength(11);
    for (const id of CHOICE_IDS) {
      const heading = screen.getByRole("heading", {
        level: 3,
        name: t(`methodology.choices.${id}.title`),
      });
      const choice = heading.closest("div");
      if (choice === null) throw new Error(`no block for ${id}`);
      expect(within(choice).getByText("What Haulcast does")).toBeInTheDocument();
      expect(within(choice).getByText("Why")).toBeInTheDocument();
      expect(within(choice).getByText(t(`methodology.choices.${id}.why`))).toBeInTheDocument();
    }
  });

  it("states the rounding the rules file asks for", () => {
    render(<MethodologyPage />);

    expect(
      screen.getByText(
        /Before a level is chosen, wind is rounded to 0\.1 mph, rain to 0\.001 in\/hr, and snow to 0\.001 in\/hr\./u,
      ),
    ).toBeInTheDocument();
  });

  it("lists the nine assumptions and the data sources with their licenses", () => {
    render(<MethodologyPage />);

    for (const id of ASSUMPTION_IDS) {
      expect(screen.getByText(t(`methodology.assumptions.${id}`))).toBeInTheDocument();
    }
    for (const id of SOURCE_IDS) {
      const link = screen.getByRole("link", {
        name: new RegExp(`^${t(`methodology.sources.${id}.name`)}`, "u"),
      });
      expect(link).toHaveAttribute("href", t(`methodology.sources.${id}.url`));
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.getByText(t(`methodology.sources.${id}.license`))).toBeInTheDocument();
    }
  });

  it("answers its questions, and the answer about loads quotes the load rules of the rules file", () => {
    const rules = changed((copy) => {
      const rule = copy.load_rules.find((candidate) => candidate.id === "LR-2");
      if (rule === undefined) throw new Error("no LR-2");
      rule.load_lb_min_exclusive = 32_000;
    });
    const { rerender } = render(<MethodologyPage />);

    for (const id of FAQ_IDS) {
      expect(screen.getByRole("heading", { level: 3, name: faqQuestion(id) })).toBeInTheDocument();
      expect(screen.getByText(faqAnswer(id, RISK_RULES))).toBeInTheDocument();
    }
    expect(faqAnswer("load", RISK_RULES)).toContain("with a load over 30,000 lb is No Travel");

    rerender(<MethodologyPage rules={rules} />);

    expect(screen.getByText(faqAnswer("load", rules))).toBeInTheDocument();
    expect(faqAnswer("load", rules)).toContain("with a load over 32,000 lb is No Travel");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<MethodologyPage />);

    await expectNoAxeViolations(container);
  });
});

describe("EtaDiagram", () => {
  it("is one picture with a name that says what it shows, and a caption", () => {
    render(<EtaDiagram />);

    expect(
      screen.getByRole("img", { name: /^Checkpoints every 25 miles along a route\./u }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Example with 25 mile checkpoints. Times are illustrative."),
    ).toBeInTheDocument();
  });

  it("marks the origin, the destination, five checkpoints with their time and distance, and the owned miles", () => {
    const { container } = render(<EtaDiagram />);

    for (const text of [
      "Origin",
      "Destination",
      "Owned miles",
      "0 mi",
      "25 mi",
      "50 mi",
      "75 mi",
      "100 mi",
      "+0:00",
      "+1:54",
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(container.querySelectorAll("circle")).toHaveLength(5);
  });
});
