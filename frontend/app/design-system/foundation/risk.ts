import { Circle, CircleDashed, Diamond, OctagonX, Square, Triangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { t } from "./strings";

/** The five scored levels, lowest to highest, exactly as `shared/risk-rules.json` and the API name them. */
export const RISK_LEVELS = ["low", "moderate", "high", "severe", "no_travel"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** A level as the API sends it: `null` means the weather data is missing (Unknown). */
export type ApiRiskLevel = RiskLevel | null;

/** Value of the `data-level` attribute the risk CSS recipes key on. */
export type RiskKey = RiskLevel | "unknown";

/** Pattern drawn over a swatch so a level never depends on colour alone (DESIGN.md section 4). */
export type RiskPattern =
  "none" | "dots" | "hatch-45" | "crosshatch" | "bars-horizontal" | "hatch-135";

/** Everything the UI needs to draw one level: word, icon, pattern, order and token names. */
export interface RiskInfo {
  /** `data-level` value, and the API string (`unknown` for null). */
  readonly key: RiskKey;
  /** The level word from the microcopy (Low, Moderate, High, Severe, No Travel, Unknown). */
  readonly label: string;
  /** Lucide icon for badges and legends (the map draws its own marker shapes). */
  readonly icon: LucideIcon;
  readonly pattern: RiskPattern;
  /**
   * 0 (Low) to 4 (No Travel); Unknown is -1, below every scored level. That is the map's drawing
   * order (`symbol-sort-key`: No Travel on top, Unknown underneath). A table or list sorts Unknown
   * last in either direction: use {@link compareRisk}, not `ordinal`, to sort one.
   */
  readonly ordinal: number;
  /** Token segment: `no-travel` for `risk-no-travel-fill` (token names use hyphens). */
  readonly tokenName: string;
}

const TABLE: Readonly<Record<RiskKey, Omit<RiskInfo, "label">>> = {
  low: { key: "low", icon: Circle, pattern: "none", ordinal: 0, tokenName: "low" },
  moderate: { key: "moderate", icon: Diamond, pattern: "dots", ordinal: 1, tokenName: "moderate" },
  high: { key: "high", icon: Triangle, pattern: "hatch-45", ordinal: 2, tokenName: "high" },
  severe: { key: "severe", icon: Square, pattern: "crosshatch", ordinal: 3, tokenName: "severe" },
  no_travel: {
    key: "no_travel",
    icon: OctagonX,
    pattern: "bars-horizontal",
    ordinal: 4,
    tokenName: "no-travel",
  },
  unknown: {
    key: "unknown",
    icon: CircleDashed,
    pattern: "hatch-135",
    ordinal: -1,
    tokenName: "unknown",
  },
};

/**
 * Describes a risk level for display.
 *
 * @param level - A level from the API; `null` or `undefined` is Unknown.
 */
export function riskInfo(level: ApiRiskLevel | undefined): RiskInfo {
  const key: RiskKey = level ?? "unknown";
  return { ...TABLE[key], label: t(`risk.${key}`) };
}

/**
 * Compares two levels the way a table column sorts them (DESIGN.md section 10: "by ordinal, Unknown
 * last"): Low to No Travel when ascending, No Travel to Low when descending, and Unknown after every
 * scored level in both directions, because "no data" is never the most or the least risky.
 *
 * @param left - A level from the API; `null` or `undefined` is Unknown.
 * @param right - The level to compare it with.
 * @param direction - `ascending` (Low first, the default) or `descending` (No Travel first).
 * @returns Negative when `left` comes first, positive when `right` does, 0 when they tie.
 */
export function compareRisk(
  left: ApiRiskLevel | undefined,
  right: ApiRiskLevel | undefined,
  direction: "ascending" | "descending" = "ascending",
): number {
  const leftInfo = riskInfo(left);
  const rightInfo = riskInfo(right);
  if (leftInfo.key === "unknown" || rightInfo.key === "unknown") {
    return Number(leftInfo.key === "unknown") - Number(rightInfo.key === "unknown");
  }
  const order = leftInfo.ordinal - rightInfo.ordinal;
  return direction === "ascending" ? order : -order;
}

/**
 * What a table column sorts a level by (`TableColumn.sortValue`): the ordinal, Low 0 to No Travel 4,
 * and `null` for Unknown, which a Table sorts last in both directions. Sorting by it gives the order
 * of {@link compareRisk}, so a risk column needs no comparator of its own.
 *
 * @param level - A level from the API; `null` or `undefined` is Unknown.
 */
export function riskSortValue(level: ApiRiskLevel | undefined): number | null {
  return level === null || level === undefined ? null : TABLE[level].ordinal;
}

/** `var(--risk-<level>-<part>)` for CSS-in-JS-free styling, e.g. `riskVar("no_travel", "fill")`. */
export function riskVar(
  level: ApiRiskLevel | undefined,
  part: "fill" | "on-fill" | "stroke",
): string {
  return `var(--risk-${riskInfo(level).tokenName}-${part})`;
}
