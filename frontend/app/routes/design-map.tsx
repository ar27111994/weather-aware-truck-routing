import type { PaddingOptions, StyleSpecification } from "maplibre-gl";
import { Suspense, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";
import { useSearchParams } from "react-router";

import type { PlanRequest } from "../api/contract";
import { buildHeatmap, buildPlan } from "../api/mocks";
import { t } from "../design-system/foundation/strings";
import type { ResolvedTheme } from "../design-system/foundation/theme";
import { useTheme } from "../design-system/foundation/ThemeProvider";
import { useMediaQuery } from "../design-system/foundation/useMediaQuery";
import { tokens } from "../design-system/tokens/tokens";
import { DEFAULT_PADDING, MapLegend, MapView, TimelineDock } from "../features/map";
import { pageMeta } from "../shell/page-meta";
import { createTripStore } from "../state/trip-store";
import styles from "./design-map.module.css";

/** DESIGN.md section 8: from this width the legend is open on the map; below it, a button. */
export const WIDE_QUERY = `(min-width: ${tokens.light["breakpoint-lg"]})`;

/**
 * Where the harness publishes `{ map, store, padding }` while its map lives, for the R7 sweep's workload
 * checks (D-39: the trip is framed, every layer drew, each step applied a new frame). Only this
 * test page publishes it.
 */
export const HARNESS_GLOBAL = "__hcHarness";

function tokenPx(token: "layout-map-inset" | "c-legend-width"): number {
  return Number.parseFloat(tokens.light[token]);
}

/**
 * Camera padding on wide screens: the open legend covers the map's lower-left corner, so the trip is
 * framed to its right (one inset past the legend's far edge).
 */
export const WIDE_PADDING: PaddingOptions = {
  ...DEFAULT_PADDING,
  left: tokenPx("layout-map-inset") * 2 + tokenPx("c-legend-width"),
};

/**
 * The fixture trip: Salt Lake City to Denver on the recorded Valhalla routes, with the scenario
 * that puts severe weather on the fastest route, so the ribbon, markers and heatmap show every
 * level. A fixed departure keeps every run (and every visual golden) identical.
 */
export const HARNESS_REQUEST: PlanRequest = {
  origin: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" },
  destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
  departure_time: "2026-10-20T14:00:00Z",
  load_weight_lb: 38_000,
  sampling_interval_mi: 25,
  scenario: "severe-on-fastest",
};

/**
 * A basemap with no tiles: the theme's land colour only. Visual goldens use it (`?basemap=blank`)
 * so a pixel never depends on third-party tiles that change every week.
 */
export function blankBasemap(theme: ResolvedTheme): StyleSpecification {
  return {
    version: 8,
    name: "Blank",
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": tokens[theme]["map-basemap-land"] },
      },
    ],
  };
}

/** A working tool, not a page for search: noindex, like `/design`. */
export function meta(): MetaDescriptor[] {
  return pageMeta({
    title: t("design.mapTitle"),
    description: t("design.mapDescription"),
    noindex: true,
  });
}

/** `/design/map`: the map, heatmap and timeline on fixture data (the perf sweep runs here). */
export default function DesignMap(): ReactElement {
  const { resolvedTheme } = useTheme();
  const [search] = useSearchParams();
  const plan = useMemo(() => buildPlan(HARNESS_REQUEST), []);
  const heatmap = useMemo(() => buildHeatmap(plan), [plan]);
  const [store] = useState(() =>
    createTripStore({ selectedRouteId: plan.recommendation.route_id }),
  );
  const blank = search.get("basemap") === "blank";
  const wide = useMediaQuery(WIDE_QUERY);
  const padding = wide ? WIDE_PADDING : DEFAULT_PADDING;
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t("design.mapTitle")}</h1>
      <div className={styles.stage}>
        <Suspense fallback={<p className={styles.loading}>{t("empty.mapLoading")}</p>}>
          <MapView
            plan={plan}
            heatmap={heatmap}
            theme={resolvedTheme}
            store={store}
            padding={padding}
            onMap={(map) => {
              Reflect.set(
                window,
                HARNESS_GLOBAL,
                map === null ? undefined : { map, store, padding },
              );
            }}
            {...(blank ? { basemap: blankBasemap } : {})}
          >
            <div className={styles.overlays}>
              {/* Keyed so crossing the breakpoint opens or closes it as the layout expects. */}
              <MapLegend
                key={wide ? "wide" : "narrow"}
                store={store}
                defaultExpanded={wide}
                className={styles.legend}
              />
              <TimelineDock heatmap={heatmap} store={store} className={styles.dock} />
            </div>
          </MapView>
        </Suspense>
      </div>
    </div>
  );
}
