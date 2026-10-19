import {
  Circle,
  CircleDashed,
  Diamond,
  OctagonX,
  Square,
  Triangle,
  type LucideIcon,
} from "lucide-react";

import { copy } from "../../copy";

/** Risk levels in severity order, Unknown last. Keys of `copy.risk` and of the miles record. */
export const RISK_LEVELS = ["low", "moderate", "high", "severe", "no_travel", "unknown"] as const;

/** One of the six risk levels (`risk.level` in the design contract; Unknown stands for `null`). */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** How a level is drawn on top of its fill (DESIGN.md section 4, rule 4). */
export type RiskPatternKind =
  "solid" | "dots" | "hatch-45" | "cross-hatch" | "bars-horizontal" | "hatch-135";

/** Everything a risk graphic needs to know about one level. */
export interface RiskLevelMeta {
  /** The visible level word, from `copy.risk`. */
  readonly label: string;
  /** Lucide shape icon of the level (DESIGN.md section 4 table). */
  readonly icon: LucideIcon;
  /** Level name as used in the risk token names (`--risk-<token>-fill`). */
  readonly token: "low" | "moderate" | "high" | "severe" | "no-travel" | "unknown";
  /** Pattern drawn over the fill. */
  readonly pattern: RiskPatternKind;
}

/**
 * Single source of the per-level metadata used by the stacked bar. T6a's generic risk Badge will
 * own this concern later; keep this module internal to the StackedBar folder until then.
 */
export const RISK_LEVEL_META: Readonly<Record<RiskLevel, RiskLevelMeta>> = {
  low: { label: copy.risk.low, icon: Circle, token: "low", pattern: "solid" },
  moderate: { label: copy.risk.moderate, icon: Diamond, token: "moderate", pattern: "dots" },
  high: { label: copy.risk.high, icon: Triangle, token: "high", pattern: "hatch-45" },
  severe: { label: copy.risk.severe, icon: Square, token: "severe", pattern: "cross-hatch" },
  no_travel: {
    label: copy.risk.no_travel,
    icon: OctagonX,
    token: "no-travel",
    pattern: "bars-horizontal",
  },
  unknown: {
    label: copy.risk.unknown,
    icon: CircleDashed,
    token: "unknown",
    pattern: "hatch-135",
  },
};
