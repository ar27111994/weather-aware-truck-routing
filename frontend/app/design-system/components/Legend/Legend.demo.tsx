import { bandWords, boundaryNote } from "../../../lib/boundary-text";
import { RISK_RULES } from "../../../lib/risk";
import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { Legend, LegendRamp, LegendRiskList } from "./Legend";

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
            bands={bandWords("wind", RISK_RULES)}
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
            bands={bandWords("rain", RISK_RULES)}
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
            bands={bandWords("snow", RISK_RULES)}
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
