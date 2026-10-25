import { boundaryNote } from "../../../features/methodology/rules-text";
import { RISK_RULES } from "../../../lib/risk";
import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { Legend, LegendRamp, LegendRiskList } from "./Legend";

const WIND_BANDS = [
  "under 25 mph",
  "25 to under 35",
  "35 to under 45",
  "45 to under 55",
  "55 mph or more",
] as const;
const RAIN_BANDS = [
  "under 0.10 in/hr",
  "0.10 to under 0.25",
  "0.25 to under 0.50",
  "0.50 to 1.00",
  "over 1.00 in/hr",
] as const;
const SNOW_BANDS = [
  "under 0.5 in/hr",
  "0.5 to under 1.0",
  "1.0 to under 2.0",
  "2.0 to 3.0",
  "over 3.0 in/hr",
] as const;

export const demo: Demo = {
  name: "Legend",
  description:
    "Map legend: the six risk rows (word, shape and pattern) and a five-step ramp for wind, rain and snow. The overlay is 280 px and folds away; the inline version never does.",
  states: [
    {
      id: "risk",
      title: "Risk level, overlay",
      node: (
        <Legend title={t("legend.risk")} footnote={boundaryNote(RISK_RULES)}>
          <LegendRiskList hints={{ unknown: t("legend.unknownHint") }} />
        </Legend>
      ),
    },
    {
      id: "risk-collapsible",
      title: "Risk level, collapsible (open)",
      node: (
        <Legend title={t("legend.risk")} isCollapsible>
          <LegendRiskList />
        </Legend>
      ),
    },
    {
      id: "risk-collapsed",
      title: "Risk level, collapsible (folded)",
      node: (
        <Legend title={t("legend.risk")} isCollapsible defaultExpanded={false}>
          <LegendRiskList />
        </Legend>
      ),
    },
    {
      id: "wind",
      title: "Wind ramp",
      node: (
        <Legend title={t("legend.wind")}>
          <LegendRamp
            field="wind"
            ticks={["15", "25", "35", "45", "55"]}
            bands={WIND_BANDS}
            unit="mph"
            note={t("legend.notShadedWind")}
          />
        </Legend>
      ),
    },
    {
      id: "rain",
      title: "Rain ramp",
      node: (
        <Legend title={t("legend.rain")}>
          <LegendRamp
            field="rain"
            ticks={["0.01", "0.10", "0.25", "0.50", "1.00"]}
            bands={RAIN_BANDS}
            unit="in/hr"
            note={t("legend.notShadedPrecip")}
          />
        </Legend>
      ),
    },
    {
      id: "snow",
      title: "Snow ramp",
      node: (
        <Legend title={t("legend.snow")}>
          <LegendRamp
            field="snow"
            ticks={["0.01", "0.5", "1.0", "2.0", "3.0"]}
            bands={SNOW_BANDS}
            unit="in/hr"
            note={t("legend.notShadedPrecip")}
          />
        </Legend>
      ),
    },
    {
      id: "inline",
      title: "Inline (methodology page), no card",
      node: (
        <Legend title={t("legend.risk")} variant="inline">
          <LegendRiskList />
        </Legend>
      ),
    },
  ],
};
