import type { ReactElement } from "react";

import type { RiskRules } from "../../api/contract";
import { Link } from "../../design-system/components/Link";
import { t, tList, type StringKey } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import { EtaDiagram } from "./EtaDiagram";
import styles from "./MethodologyPage.module.css";
import { RiskTable } from "./RiskTable";
import {
  FAQ_IDS,
  boundaryExceptions,
  faqAnswer,
  faqQuestion,
  loadIntro,
  loadLimits,
  loadRange,
  loadRuleSentences,
  precisionPhrase,
  rankingEntries,
  toleranceSentence,
} from "./rules-text";

/** The sections in reading order: the address each has, and the heading it shows. */
export const SECTIONS = [
  { id: "rules", title: "methodology.sections.rules" },
  { id: "boundaries", title: "methodology.sections.boundaries" },
  { id: "load", title: "methodology.sections.load" },
  { id: "sampling", title: "methodology.sections.sampling" },
  { id: "ranking", title: "methodology.sections.ranking" },
  { id: "choices", title: "methodology.sections.choices" },
  { id: "assumptions", title: "methodology.sections.assumptions" },
  { id: "limits", title: "methodology.sections.limits" },
  { id: "sources", title: "methodology.sections.sources" },
  { id: "faq", title: "methodology.sections.faq" },
] as const satisfies readonly { readonly id: string; readonly title: StringKey }[];

/** The deliberate rule choices, in the order they are explained (the T9 audit's list, plus coverage). */
export const CHOICE_IDS = [
  "noTravelFirst",
  "coverage",
  "bandEdges",
  "quantization",
  "sustainedWind",
  "lattice",
  "fewerRoutes",
  "heatmapAnchor",
  "unknownMiles",
  "noBreaks",
  "rounding",
] as const;

/** The assumptions D-01 to D-09. */
export const ASSUMPTION_IDS = [
  "d01",
  "d02",
  "d03",
  "d04",
  "d05",
  "d06",
  "d07",
  "d08",
  "d09",
] as const;

/** The places the data and the software come from. */
export const SOURCE_IDS = [
  "openmeteo",
  "osm",
  "openfreemap",
  "photon",
  "valhalla",
  "code",
] as const;

/** The words for one deliberate choice. */
function Choice({
  id,
  rules,
}: {
  readonly id: (typeof CHOICE_IDS)[number];
  readonly rules: RiskRules;
}): ReactElement {
  const what =
    id === "quantization"
      ? t("methodology.choices.quantization.what", { precisions: precisionPhrase(rules) })
      : t(`methodology.choices.${id}.what`);
  return (
    <div className={styles.choice}>
      <h3 className={styles.subheading}>{t(`methodology.choices.${id}.title`)}</h3>
      <dl className={styles.pairs}>
        <dt className={styles.term}>{t("methodology.choices.what")}</dt>
        <dd className={styles.detail}>{what}</dd>
        <dt className={styles.term}>{t("methodology.choices.why")}</dt>
        <dd className={styles.detail}>{t(`methodology.choices.${id}.why`)}</dd>
      </dl>
    </div>
  );
}

/**
 * How Haulcast scores weather risk (R11), written for the person who will use the answer. The
 * numbers on it (thresholds, load rules, ranking order, rounding, the weight routing assumes) are
 * read from the rules file, so the page cannot say one thing while the engine does another. Pass
 * `rules` to render a different rules document.
 */
export function MethodologyPage({
  rules = RISK_RULES,
}: {
  readonly rules?: RiskRules;
}): ReactElement {
  const limit = loadLimits(rules);
  return (
    <div className={styles.page}>
      <nav aria-label={t("methodology.nav.label")} className={styles.toc}>
        <p className={styles.tocTitle}>{t("methodology.nav.label")}</p>
        <ul className={styles.list}>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <Link href={`#${section.id}`} variant="nav">
                {t(section.title)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className={styles.article}>
        <h1 className={styles.title}>{t("methodology.title")}</h1>
        <p className={styles.lead}>{t("methodology.lead")}</p>

        <section aria-labelledby="rules" className={styles.section}>
          <h2 id="rules" className={styles.heading}>
            {t("methodology.sections.rules")}
          </h2>
          <RiskTable rules={rules} />
          <p className={styles.prose}>{t("methodology.rules.factors")}</p>
          <p className={styles.hint}>{t("methodology.rules.note")}</p>
        </section>

        <section aria-labelledby="boundaries" className={styles.section}>
          <h2 id="boundaries" className={styles.heading}>
            {t("methodology.sections.boundaries")}
          </h2>
          <p className={styles.prose}>
            {t("methodology.boundaries.rule", { exceptions: boundaryExceptions(rules) })}
          </p>
          <p className={styles.prose}>{t("methodology.boundaries.why")}</p>
        </section>

        <section aria-labelledby="load" className={styles.section}>
          <h2 id="load" className={styles.heading}>
            {t("methodology.sections.load")}
          </h2>
          <p className={styles.prose}>{loadIntro(rules)}</p>
          <ul className={styles.list}>
            {loadRuleSentences(rules).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
          {limit === null ? null : (
            <p className={styles.prose}>{t("methodology.load.strict", { limits: limit })}</p>
          )}
          <p className={styles.hint}>{loadRange(rules)}</p>
        </section>

        <section aria-labelledby="sampling" className={styles.section}>
          <h2 id="sampling" className={styles.heading}>
            {t("methodology.sections.sampling")}
          </h2>
          <p className={styles.prose}>{t("methodology.sampling.intro")}</p>
          <EtaDiagram />
          <p className={styles.prose}>{t("methodology.sampling.owned")}</p>
        </section>

        <section aria-labelledby="ranking" className={styles.section}>
          <h2 id="ranking" className={styles.heading}>
            {t("methodology.sections.ranking")}
          </h2>
          <p className={styles.prose}>{t("methodology.ranking.intro")}</p>
          <ol className={styles.list}>
            {rankingEntries(rules).map((entry) => (
              <li key={entry.id}>{entry.text}</li>
            ))}
          </ol>
          <p className={styles.prose}>{rules.ranking.extension_note}</p>
          <p className={styles.prose}>{toleranceSentence(rules)}</p>
          <p className={styles.prose}>{t("methodology.ranking.status")}</p>
        </section>

        <section aria-labelledby="choices" className={styles.section}>
          <h2 id="choices" className={styles.heading}>
            {t("methodology.sections.choices")}
          </h2>
          <p className={styles.prose}>{t("methodology.choices.intro")}</p>
          {CHOICE_IDS.map((id) => (
            <Choice key={id} id={id} rules={rules} />
          ))}
        </section>

        <section aria-labelledby="assumptions" className={styles.section}>
          <h2 id="assumptions" className={styles.heading}>
            {t("methodology.sections.assumptions")}
          </h2>
          <ol className={styles.list}>
            {ASSUMPTION_IDS.map((id) => (
              <li key={id}>{t(`methodology.assumptions.${id}`)}</li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="limits" className={styles.section}>
          <h2 id="limits" className={styles.heading}>
            {t("methodology.sections.limits")}
          </h2>
          <ul className={styles.list}>
            {tList("methodology.limits.items").map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="sources" className={styles.section}>
          <h2 id="sources" className={styles.heading}>
            {t("methodology.sections.sources")}
          </h2>
          <ul className={styles.sources}>
            {SOURCE_IDS.map((id) => (
              <li key={id}>
                <span className={styles.sourceName}>
                  <Link href={t(`methodology.sources.${id}.url`)} isExternal>
                    {t(`methodology.sources.${id}.name`)}
                  </Link>
                </span>
                <span>{t(`methodology.sources.${id}.use`)}</span>
                <span className={styles.license}>{t(`methodology.sources.${id}.license`)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="faq" className={styles.section}>
          <h2 id="faq" className={styles.heading}>
            {t("methodology.sections.faq")}
          </h2>
          {FAQ_IDS.map((id) => (
            <div key={id} className={styles.choice}>
              <h3 className={styles.subheading}>{faqQuestion(id)}</h3>
              <p className={styles.prose}>{faqAnswer(id, rules)}</p>
            </div>
          ))}
        </section>
      </article>
    </div>
  );
}
