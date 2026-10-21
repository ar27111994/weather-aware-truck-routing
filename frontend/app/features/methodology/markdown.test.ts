import { describe, expect, it } from "vitest";

import { t } from "../../design-system/foundation/strings";
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

  it("leaves out the load limits sentence when no rule depends on the weight", () => {
    const rules = structuredClone(RISK_RULES);
    for (const rule of rules.load_rules) rule.load_lb_min_exclusive = null;

    expect(methodologySections(rules)).not.toContain("does not trigger a rule");
    expect(methodologySections(RISK_RULES)).toContain("does not trigger a rule");
  });
});
