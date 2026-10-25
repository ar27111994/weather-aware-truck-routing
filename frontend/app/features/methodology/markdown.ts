import type { RiskRules } from "../../api/contract";
import { t, tList } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import { ASSUMPTION_IDS, CHOICE_IDS, SOURCE_IDS, choiceWhat } from "./MethodologyPage";
import {
  FAQ_IDS,
  boundaryRule,
  faqAnswer,
  faqQuestion,
  loadIntro,
  loadLimits,
  loadRange,
  loadRuleSentences,
  rankingEntries,
  riskTableRows,
  toleranceSentence,
} from "./rules-text";

/** A GitHub-flavoured Markdown table. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${String(index + 1)}. ${item}`).join("\n");
}

function levelNames(rules: RiskRules): string[] {
  return [...rules.levels].sort((a, b) => a.ordinal - b.ordinal).map((level) => level.label);
}

/**
 * The sections of the methodology page as Markdown, from the risk table to the questions. It is
 * built from the same rules file and the same words as the page (`MethodologyPage`), so a person
 * reading the page and a program reading `llms-full.txt` get the same account.
 */
export function methodologySections(rules: RiskRules = RISK_RULES): string {
  const limit = loadLimits(rules);
  const blocks: string[] = [
    `## ${t("methodology.sections.rules")}`,
    table(
      [t("methodology.tableCols.condition"), ...levelNames(rules)],
      riskTableRows(rules).map((row) => [row.name, ...row.cells.map((cell) => cell.text)]),
    ),
    t("methodology.rules.factors"),
    t("methodology.rules.note"),

    `## ${t("methodology.sections.boundaries")}`,
    boundaryRule(rules),
    t("methodology.boundaries.why"),

    `## ${t("methodology.sections.load")}`,
    loadIntro(rules),
    bullets(loadRuleSentences(rules)),
    ...(limit === null ? [] : [t("methodology.load.strict", { limits: limit })]),
    loadRange(rules),

    `## ${t("methodology.sections.sampling")}`,
    t("methodology.sampling.intro"),
    t("methodology.sampling.owned"),

    `## ${t("methodology.sections.ranking")}`,
    t("methodology.ranking.intro"),
    numbered(rankingEntries(rules).map((entry) => entry.text)),
    rules.ranking.extension_note,
    toleranceSentence(rules),
    t("methodology.ranking.status"),

    `## ${t("methodology.sections.choices")}`,
    t("methodology.choices.intro"),
    ...CHOICE_IDS.flatMap((id) => [
      `### ${t(`methodology.choices.${id}.title`)}`,
      choiceWhat(id, rules),
      `${t("methodology.choices.why")}: ${t(`methodology.choices.${id}.why`)}`,
    ]),

    `## ${t("methodology.sections.assumptions")}`,
    numbered(ASSUMPTION_IDS.map((id) => t(`methodology.assumptions.${id}`))),

    `## ${t("methodology.sections.limits")}`,
    bullets(tList("methodology.limits.items")),

    `## ${t("methodology.sections.sources")}`,
    bullets(
      SOURCE_IDS.map(
        (id) =>
          `[${t(`methodology.sources.${id}.name`)}](${t(`methodology.sources.${id}.url`)}): ${t(`methodology.sources.${id}.use`)} ${t(`methodology.sources.${id}.license`)}.`,
      ),
    ),

    `## ${t("methodology.sections.faq")}`,
    ...FAQ_IDS.flatMap((id) => [`### ${faqQuestion(id)}`, faqAnswer(id, rules)]),
  ];
  return blocks.join("\n\n");
}

/** The whole methodology page as one Markdown document, ending in a newline. */
export function methodologyMarkdown(rules: RiskRules = RISK_RULES): string {
  return `# ${t("methodology.title")}\n\n${t("methodology.lead")}\n\n${methodologySections(rules)}\n`;
}
