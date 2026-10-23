import { useMemo, type ReactElement } from "react";
import { useLocale } from "react-aria";

import type { Checkpoint, Route } from "../../api/contract";
import { Badge } from "../../design-system/components/Badge";
import { Table, type TableColumn } from "../../design-system/components/Table";
import { riskSortValue } from "../../design-system/foundation/risk";
import { t } from "../../design-system/foundation/strings";
import { formatMiles } from "../../lib/format";
import { useHoveredCheckpoint, useTripActions } from "../../state";
import { checkpointClock, weatherValue } from "./route-format";
import styles from "./CheckpointTable.module.css";

/** A reading with its factor's risk level beside it: the value, then the level badge. */
function Reading({
  text,
  level,
}: {
  readonly text: string;
  readonly level: Checkpoint["risk"]["level"];
}): ReactElement {
  return (
    <span className={styles.reading}>
      {text}
      <Badge level={level} variant="subtle" />
    </span>
  );
}

/** The columns of the checkpoint table (DESIGN.md section 10), their sort values and their cells. */
function checkpointColumns(locale: string): readonly TableColumn<Checkpoint>[] {
  return [
    {
      id: "index",
      header: t("table.cols.index"),
      numeric: true,
      sortValue: (c) => c.index,
      cell: (c) => String(c.index),
    },
    {
      id: "distance",
      header: t("table.cols.distance"),
      numeric: true,
      sortable: true,
      sortValue: (c) => c.distance_mi,
      cell: (c) => formatMiles(c.distance_mi, { unit: false, locale }),
    },
    {
      id: "eta",
      header: t("table.cols.eta"),
      sortable: true,
      sortValue: (c) => Date.parse(c.eta),
      cell: (c) => checkpointClock(c, locale),
    },
    {
      id: "level",
      header: t("table.cols.level"),
      sortable: true,
      sortValue: (c) => riskSortValue(c.risk.level),
      cell: (c) => <Badge level={c.risk.level} variant="subtle" />,
    },
    {
      id: "wind",
      header: t("table.cols.wind"),
      numeric: true,
      sortable: true,
      sortValue: (c) => c.weather.wind_mph,
      cell: (c) => (
        <Reading
          text={weatherValue(c.weather.wind_mph, "wind", locale)}
          level={c.risk.factors.wind}
        />
      ),
    },
    {
      id: "gust",
      header: t("table.cols.gust"),
      numeric: true,
      cell: (c) => weatherValue(c.weather.gust_mph, "gust", locale),
    },
    {
      id: "rain",
      header: t("table.cols.rain"),
      numeric: true,
      sortable: true,
      sortValue: (c) => c.weather.rain_in_hr,
      cell: (c) => (
        <Reading
          text={weatherValue(c.weather.rain_in_hr, "rain", locale)}
          level={c.risk.factors.rain}
        />
      ),
    },
    {
      id: "snow",
      header: t("table.cols.snow"),
      numeric: true,
      sortable: true,
      sortValue: (c) => c.weather.snow_in_hr,
      cell: (c) => (
        <Reading
          text={weatherValue(c.weather.snow_in_hr, "snow", locale)}
          level={c.risk.factors.snow}
        />
      ),
    },
    {
      id: "temp",
      header: t("table.cols.temp"),
      numeric: true,
      cell: (c) => weatherValue(c.weather.temperature_f, "temp", locale),
    },
    {
      id: "loadRule",
      header: t("table.cols.loadRule"),
      cell: (c) => c.risk.load_rule ?? t("table.noRule"),
    },
  ];
}

/**
 * The checkpoints of one route as a sortable table (R8): the non-visual equivalent of the map, with
 * ETA on the local clock, distance, wind, gust, rain, snow and temperature, the level of each factor
 * beside its value, and the load rule that fired. The row for the checkpoint hovered or focused on
 * the map or the risk profile is selected, and choosing a row selects that checkpoint there.
 */
export function CheckpointTable({ route }: { readonly route: Route }): ReactElement {
  const { locale } = useLocale();
  const columns = useMemo(() => checkpointColumns(locale), [locale]);
  const hovered = useHoveredCheckpoint();
  const { hoverCheckpoint } = useTripActions();
  return (
    <Table
      regionLabel={t("table.regionLabel", { route: route.route_id })}
      columns={columns}
      rows={route.checkpoints}
      getRowId={(checkpoint) => String(checkpoint.index)}
      defaultSortDescriptor={{ column: "index", direction: "ascending" }}
      selectedKey={hovered?.routeId === route.route_id ? String(hovered.index) : null}
      onSelectionChange={(key) => {
        hoverCheckpoint(key === null ? null : { routeId: route.route_id, index: Number(key) });
      }}
    />
  );
}
