import type { ReactElement } from "react";

import type { RiskRules } from "../../api/contract";
import { Legend, LegendRamp, LegendRiskList } from "../../design-system/components/Legend";
import { t, tList } from "../../design-system/foundation/strings";
import { boundaryNote } from "../../lib/boundary-text";
import { at } from "../../lib/checked";
import { RISK_RULES } from "../../lib/risk";
import { tripStore, useHeatmapField } from "../../state/trip-store";
import type { TripStore } from "../../state/trip-store";
import { legendTicks } from "./heatmap";
import type { WeatherLayer } from "./heatmap";
import styles from "./MapLegend.module.css";

export interface MapLegendProps {
  readonly store?: TripStore;
  /** The rules the legend is written from; the bundled rules unless a page passes others. */
  readonly rules?: RiskRules;
  /** Level of the legend's disclosure heading, to fit the page's outline. */
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  readonly defaultExpanded?: boolean;
  readonly className?: string;
}

const FACTOR = { wind_mph: "wind", rain_in_hr: "rain", snow_in_hr: "snow" } as const;

function WeatherRamp({
  layer,
  rules,
}: {
  readonly layer: WeatherLayer;
  readonly rules: RiskRules;
}): ReactElement {
  const factor = FACTOR[layer];
  const bands = tList(`legend.band.${factor}`);
  return (
    <>
      <LegendRamp
        field={factor}
        ticks={legendTicks(layer, rules)}
        bands={[at(bands, 0), at(bands, 1), at(bands, 2), at(bands, 3), at(bands, 4)]}
        unit={rules.factors[factor].unit}
        note={factor === "wind" ? t("legend.notShadedWind") : t("legend.notShadedPrecip")}
      />
      {/* Missing forecast values are shaded grey, never left clear like calm weather (D-31). */}
      <p className={styles.unknown}>
        <span className={styles.unknownSwatch} aria-hidden="true" />
        {t("legend.unknownHint")}
      </p>
    </>
  );
}

/** The map legend for the heatmap layer the store shows (DESIGN.md section 9.9). */
export function MapLegend({
  store = tripStore,
  rules = RISK_RULES,
  headingLevel = 2,
  defaultExpanded = true,
  className,
}: MapLegendProps): ReactElement {
  const field = useHeatmapField(store);
  const title = field === "risk" ? t("legend.risk") : t(`legend.${FACTOR[field]}`);
  return (
    <Legend
      title={title}
      isCollapsible
      defaultExpanded={defaultExpanded}
      headingLevel={headingLevel}
      footnote={boundaryNote(rules)}
      {...(className === undefined ? {} : { className })}
    >
      {field === "risk" ? (
        <LegendRiskList hints={{ unknown: t("legend.unknownHint") }} />
      ) : (
        <WeatherRamp layer={field} rules={rules} />
      )}
    </Legend>
  );
}
