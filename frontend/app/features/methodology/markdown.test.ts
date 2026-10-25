import { describe, expect, it } from "vitest";

import { t } from "../../design-system/foundation/strings";
import { closeUpperEdge, relabel, validRules } from "../../../test/risk-rules-variants";
import { RISK_RULES } from "../../lib/risk";
import { CHOICE_IDS, SECTIONS } from "./MethodologyPage";
import { methodologyMarkdown, methodologySections } from "./markdown";
import { FAQ_IDS, faqQuestion } from "./rules-text";

describe("methodologyMarkdown", () => {
  const markdown = methodologyMarkdown();

  it("starts with the title and the lead, and ends with one newline", () => {
    expect(
      markdown.startsWith("# How Haulcast scores weather risk\n\nEvery checkpoint is scored"),
    ).toBe(true);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("has a heading for every section of the page, in the page's order", () => {
    const headings = [...markdown.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);

    expect(headings).toEqual(SECTIONS.map((section) => t(section.title)));
  });

  it("explains every deliberate choice and answers every question", () => {
    for (const id of CHOICE_IDS) {
      expect(markdown).toContain(`### ${t(`methodology.choices.${id}.title`)}`);
      expect(markdown).toContain(t(`methodology.choices.${id}.why`));
    }
    for (const id of FAQ_IDS) {
      expect(markdown).toContain(`### ${faqQuestion(id)}`);
    }
  });

  it("writes the risk table from the rules file as a Markdown table", () => {
    expect(markdown).toContain("| Condition | Low | Moderate | High | Severe | No Travel |");
    expect(markdown).toContain("| --- | --- | --- | --- | --- | --- |");
    expect(markdown).toContain(
      "| Wind (mph) | under 25 | 25 to under 35 | 35 to under 45 | 45 to under 55 | 55 or more |",
    );
    expect(markdown).toContain(
      "| Rain (in/hr) | under 0.10 | 0.10 to under 0.25 | 0.25 to under 0.50 | 0.50 to 1.00 | over 1.00 |",
    );
  });

  it("writes the load rules and the ranking as lists", () => {
    expect(markdown).toContain(
      "- LR-3: wind from 35 to under 45 mph with a load over 40,000 lb is Severe.",
    );
    expect(markdown).toContain(
      "1. Fewest No Travel miles\n2. Most complete weather data\n3. Fewest Severe miles",
    );
    expect(markdown).toContain(RISK_RULES.ranking.extension_note);
  });

  it("follows the rules it is given", () => {
    const rules = structuredClone(RISK_RULES);
    const rule = rules.load_rules.find((candidate) => candidate.id === "LR-2");
    if (rule === undefined) throw new Error("no LR-2");
    rule.load_lb_min_exclusive = 32_000;

    expect(methodologySections(rules)).toContain("with a load over 32,000 lb is No Travel");
    expect(methodologySections(rules)).not.toContain("with a load over 30,000 lb is No Travel");
  });

  it("states where a value on an edge goes in the words of the rules it is given (RT-F2)", () => {
    const rules = validRules((copy) => {
      closeUpperEdge(copy, "wind", "high");
      relabel(copy, "severe", "Extreme");
    });

    const sections = methodologySections(rules);

    expect(sections).toContain(
      "belongs to the higher band, except wind at exactly 45 mph, which stays High, and rain at " +
        "exactly 1.00 in/hr and snow at exactly 3.0 in/hr, which stay Extreme.",
    );
    expect(sections).toContain(
      "Wind at exactly 45 mph stays High. Rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr " +
        "stay Extreme, because the brief calls No Travel anything over those values.",
    );
    expect(sections).not.toContain("which stay Severe");
  });

  it("writes assumption D-01, the factors paragraph and the answer about the levels from the rules (RT-F4)", () => {
    const rules = validRules((copy) => {
      closeUpperEdge(copy, "wind", "high");
      relabel(copy, "low", "Calm");
      copy.factors.wind.label = "Gusts";
    });

    const sections = methodologySections(rules);

    expect(sections).toContain(
      "1. Each band includes its lower number, except gusts at exactly 45 mph, which stays High (D-01).\n2. ",
    );
    expect(sections).toContain(
      "A checkpoint takes the highest level among gusts, rain and snow. A factor with no forecast " +
        "is left out and the checkpoint is marked incomplete. When all three are missing, the " +
        "checkpoint is Unknown.",
    );
    expect(sections).toContain(
      "Calm, Moderate, High, Severe and No Travel come from gusts, rain and snow thresholds. Each " +
        "factor has five ranges, and a checkpoint takes the highest level among them. Missing " +
        "data is Unknown, never Calm.",
    );
  });

  it("leaves out the load limits sentence when no rule depends on the weight", () => {
    const rules = structuredClone(RISK_RULES);
    for (const rule of rules.load_rules) rule.load_lb_min_exclusive = null;

    expect(methodologySections(rules)).not.toContain("does not trigger a rule");
    expect(methodologySections(RISK_RULES)).toContain("does not trigger a rule");
  });
});
