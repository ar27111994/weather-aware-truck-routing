/**
 * The sentences that say where a value exactly on the edge of a band goes: the methodology page's
 * boundary rule (also in its markdown and in llms-full.txt), the map legend's footnote and the
 * methodology page's "where one band ends" choice (RT-F2). All three are written from one fact,
 * `boundaryGroups`, and from the rules they are given: no band name, factor name, edge value or
 * unit is written here, so a rules file that the engine accepts never makes one of them false.
 *
 * This is in lib/ and not with the methodology page because the legend needs it too, in the map
 * and in the style guide's demo, and the style guide may not import a feature (D-61).
 */
import type { RiskBand, RiskLevel, RiskRules } from "../api/contract";
import { RISK_FACTORS } from "../api/vocabulary";
import { t, tPlural } from "../design-system/foundation/strings";
import { at } from "./checked";
import { riskLevelInfo } from "./risk";

/** English, like the methodology page's own lists, so the prerendered text never differs from the browser's. */
const LIST = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

/** A number as the rules file writes it, counted to the decimals it needs. */
function decimalsOf(value: number): number {
  const text = String(value);
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}

function edgesOf(band: RiskBand): number[] {
  return [band.min_inclusive, band.min_exclusive, band.max_inclusive, band.max_exclusive].filter(
    (edge): edge is number => edge !== undefined,
  );
}

/**
 * How many decimals print every edge of a factor the same way: the most any edge needs. Rain's
 * edges are 0.1, 0.25, 0.5 and 1, so all four print with two (0.10, 0.25, 0.50, 1.00).
 */
export function edgeDecimals(bands: readonly RiskBand[]): number {
  return Math.max(0, ...bands.flatMap((band) => edgesOf(band).map(decimalsOf)));
}

/** A reading and its unit: "25.0 mph". */
function withUnit(text: string, unit: string): string {
  return t("methodology.boundaries.withUnit", { text, unit });
}

/** The text with its first letter in capitals, for a sentence that starts with it. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One value that stays in its band exactly on the band's upper edge. */
interface BoundaryStay {
  /** The factor, in lower case: "rain". */
  readonly factor: string;
  /** The edge, printed the way the risk table prints the edges of the factor. */
  readonly value: string;
  readonly unit: string;
  /** Whether the brief writes the band above as an open range (">1.00"). */
  readonly briefSaysOver: boolean;
}

/** The values that stay in one band exactly on its upper edge, and the band that starts over them. */
interface BoundaryGroup {
  readonly level: string;
  readonly above: string;
  readonly stays: readonly BoundaryStay[];
}

/** A band's values as they are collected, factor by factor. */
interface PendingGroup {
  readonly above: RiskLevel;
  readonly stays: BoundaryStay[];
}

/**
 * The one fact behind every sentence about the edges of the bands: which values stay in their
 * band exactly on its upper edge (`max_inclusive`; the band above starts over it), grouped by
 * band in the order the rules file lists them. A value exactly on any other edge belongs to the
 * band above. The backend loader makes the two sides of an edge agree, so this is the whole list.
 */
function boundaryGroups(rules: RiskRules): readonly BoundaryGroup[] {
  const groups = new Map<RiskLevel, PendingGroup>();
  for (const factor of RISK_FACTORS) {
    const { label, unit, bands, brief_labels: brief } = rules.factors[factor];
    const decimals = edgeDecimals(bands);
    for (const [index, band] of bands.entries()) {
      if (band.max_inclusive === undefined) continue;
      const group: PendingGroup = groups.get(band.level) ?? {
        above: at(bands, index + 1).level,
        stays: [],
      };
      group.stays.push({
        factor: label.toLowerCase(),
        value: band.max_inclusive.toFixed(decimals),
        unit,
        briefSaysOver: at(brief, index + 1).startsWith(">"),
      });
      groups.set(band.level, group);
    }
  }
  return [...groups].map(([level, { above, stays }]) => ({
    level: riskLevelInfo(level, rules).label,
    above: riskLevelInfo(above, rules).label,
    stays,
  }));
}

/** The values of one band in words, each with its unit: "rain at exactly 1.00 in/hr and snow at exactly 3.0 in/hr". */
function staysText(stays: readonly BoundaryStay[]): string {
  return LIST.format(
    stays.map(({ factor, value, unit }) =>
      withUnit(t("methodology.boundaries.exception", { factor, value }), unit),
    ),
  );
}

/** The same, for a small space: values that share a unit say it once, after the last. */
function staysTextShort(stays: readonly BoundaryStay[]): string {
  const { unit } = at(stays, 0);
  if (!stays.every((stay) => stay.unit === unit)) return staysText(stays);
  return withUnit(
    LIST.format(
      stays.map(({ factor, value }) => t("methodology.boundaries.exception", { factor, value })),
    ),
    unit,
  );
}

/**
 * Clauses that carry commas of their own, one after the other, with a comma before the last one
 * even when there are only two, so the reader can tell where one ends: "A, which stays High, and
 * B, which stay Severe".
 */
function joinClauses(clauses: readonly string[]): string {
  const last = at(clauses, clauses.length - 1);
  if (clauses.length === 1) return last;
  return `${clauses.slice(0, -1).join(", ")}, ${t("methodology.boundaries.and")} ${last}`;
}

/** What a sentence adds when some values stay in their band on its edge: nothing when none do. */
function exceptionClause(
  groups: readonly BoundaryGroup[],
  write: (stays: readonly BoundaryStay[]) => string,
): string {
  if (groups.length === 0) return "";
  const clauses = groups.map(({ level, stays }) =>
    t("methodology.boundaries.group", {
      list: write(stays),
      stay: tPlural("methodology.boundaries.stay", stays.length),
      level,
    }),
  );
  return t("methodology.boundaries.except", { groups: joinClauses(clauses) });
}

/** Where a value exactly on the edge of a band goes, as the methodology page says it. */
export function boundaryRule(rules: RiskRules): string {
  return t("methodology.boundaries.rule", {
    exceptions: exceptionClause(boundaryGroups(rules), staysText),
  });
}

/** The same, as the map legend's footnote says it. */
export function boundaryNote(rules: RiskRules): string {
  return t("legend.boundaryNote", {
    exceptions: exceptionClause(boundaryGroups(rules), staysTextShort),
  });
}

/**
 * A value exactly on an edge that a band includes, and the value one display step below it
 * (the precision of the factor, which is what the engine rounds to), with the band each is in:
 * "25.0 mph is Moderate and 24.9 mph is Low". It is taken from the first edge the rules write
 * as `min_inclusive`, so the example never shows a value on an edge that closes a band; `null`
 * when no edge is written that way.
 */
function edgeExample(rules: RiskRules): string | null {
  for (const factor of RISK_FACTORS) {
    const { unit, precision, bands } = rules.factors[factor];
    const decimals = decimalsOf(precision);
    for (const [index, band] of bands.entries()) {
      if (band.min_inclusive === undefined) continue;
      return t("methodology.choices.bandEdges.what", {
        onEdge: withUnit(band.min_inclusive.toFixed(decimals), unit),
        onLevel: riskLevelInfo(band.level, rules).label,
        offEdge: withUnit((band.min_inclusive - precision).toFixed(decimals), unit),
        offLevel: riskLevelInfo(at(bands, index - 1).level, rules).label,
      });
    }
  }
  return null;
}

/**
 * The "where one band ends and the next begins" choice: the example, then one sentence for each
 * band whose upper edge belongs to it. The reason is the brief's only when the brief writes the
 * band above every one of those values as an open range (its label starts with ">").
 */
export function bandEdgesText(rules: RiskRules): string {
  const example = edgeExample(rules);
  const sentences = boundaryGroups(rules).map(({ level, above, stays }) =>
    t("methodology.choices.bandEdges.stays", {
      list: capitalized(staysText(stays)),
      stay: tPlural("methodology.boundaries.stay", stays.length),
      level,
      because: stays.every((stay) => stay.briefSaysOver)
        ? t("methodology.choices.bandEdges.because", { above })
        : "",
    }),
  );
  return [...(example === null ? [] : [example]), ...sentences].join(" ");
}
