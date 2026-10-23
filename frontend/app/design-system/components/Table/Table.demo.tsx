import type { SortDescriptor } from "react-aria-components";

import type { Demo } from "../../foundation/demo";
import { riskInfo, riskSortValue } from "../../foundation/risk";
import type { ApiRiskLevel } from "../../foundation/risk";
import { t } from "../../foundation/strings";
import { Table } from "./Table";
import type { TableColumn } from "./Table";

interface Checkpoint {
  /** Position along the route, from 1. */
  readonly n: number;
  readonly miles: number;
  /** Arrival as epoch milliseconds, so it sorts as a number. */
  readonly eta: number;
  /** `null` is Unknown: the checkpoint has no weather data. */
  readonly level: ApiRiskLevel;
  readonly wind: number | null;
  readonly gust: number | null;
  readonly rain: number | null;
  readonly snow: number | null;
  readonly temp: number | null;
  readonly loadRule: string | null;
}

/** Tuesday 13:00 UTC. The demo formats times in UTC and en-US so every golden reads the same. */
const DEPARTURE = Date.UTC(2026, 0, 13, 13, 0);
const MINUTE = 60_000;

const CHECKPOINTS: readonly Checkpoint[] = [
  {
    n: 1,
    miles: 0,
    eta: DEPARTURE,
    level: "low",
    wind: 12,
    gust: 18,
    rain: 0,
    snow: 0,
    temp: 54,
    loadRule: null,
  },
  {
    n: 2,
    miles: 28,
    eta: DEPARTURE + 31 * MINUTE,
    level: "low",
    wind: 18,
    gust: 24,
    rain: 0.02,
    snow: 0,
    temp: 51,
    loadRule: null,
  },
  {
    n: 3,
    miles: 61,
    eta: DEPARTURE + 68 * MINUTE,
    level: "moderate",
    wind: 28,
    gust: 36,
    rain: 0.12,
    snow: 0,
    temp: 47,
    loadRule: null,
  },
  {
    n: 4,
    miles: 94,
    eta: DEPARTURE + 106 * MINUTE,
    level: "severe",
    wind: 41,
    gust: 53,
    rain: 0.62,
    snow: 0.6,
    temp: 33,
    loadRule: null,
  },
  {
    n: 5,
    miles: 133,
    eta: DEPARTURE + 151 * MINUTE,
    level: "no_travel",
    wind: 58,
    gust: 71,
    rain: 1.15,
    snow: 3.4,
    temp: 29,
    loadRule: "LR-2",
  },
  {
    n: 6,
    miles: 168,
    eta: DEPARTURE + 192 * MINUTE,
    level: null,
    wind: null,
    gust: null,
    rain: null,
    snow: null,
    temp: null,
    loadRule: null,
  },
  {
    n: 7,
    miles: 201,
    eta: DEPARTURE + 233 * MINUTE,
    level: "high",
    wind: 38,
    gust: 49,
    rain: 0.31,
    snow: 0.1,
    temp: 41,
    loadRule: null,
  },
  {
    n: 8,
    miles: 245,
    eta: DEPARTURE + 281 * MINUTE,
    level: "low",
    wind: 14,
    gust: 20,
    rain: 0,
    snow: 0,
    temp: 46,
    loadRule: null,
  },
];

const NO_CHECKPOINTS: readonly Checkpoint[] = [];

const WIND_DESCENDING: SortDescriptor = { column: "wind", direction: "descending" };

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const TWO_DECIMALS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const ETA = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function checkpointId(checkpoint: Checkpoint): string {
  return String(checkpoint.n);
}

/** A reading, or "No data" where the checkpoint has none. */
function reading(value: number | null, format: Intl.NumberFormat): string {
  return value === null ? t("popover.missing") : format.format(value);
}

function indexCell(checkpoint: Checkpoint): string {
  return WHOLE.format(checkpoint.n);
}

function distanceCell(checkpoint: Checkpoint): string {
  return WHOLE.format(checkpoint.miles);
}

function etaCell(checkpoint: Checkpoint): string {
  return ETA.format(checkpoint.eta);
}

function levelCell(checkpoint: Checkpoint): string {
  return riskInfo(checkpoint.level).label;
}

function windCell(checkpoint: Checkpoint): string {
  return reading(checkpoint.wind, WHOLE);
}

function gustCell(checkpoint: Checkpoint): string {
  return reading(checkpoint.gust, WHOLE);
}

function rainCell(checkpoint: Checkpoint): string {
  return reading(checkpoint.rain, TWO_DECIMALS);
}

function snowCell(checkpoint: Checkpoint): string {
  return reading(checkpoint.snow, ONE_DECIMAL);
}

function tempCell(checkpoint: Checkpoint): string {
  return reading(checkpoint.temp, WHOLE);
}

function loadRuleCell(checkpoint: Checkpoint): string {
  return checkpoint.loadRule ?? t("table.noRule");
}

function indexValue(checkpoint: Checkpoint): number {
  return checkpoint.n;
}

function distanceValue(checkpoint: Checkpoint): number {
  return checkpoint.miles;
}

function etaValue(checkpoint: Checkpoint): number {
  return checkpoint.eta;
}

/** Levels sort by severity (Low to No Travel); Unknown has no value, so the Table sorts it last. */
function levelValue(checkpoint: Checkpoint): number | null {
  return riskSortValue(checkpoint.level);
}

function windValue(checkpoint: Checkpoint): number | null {
  return checkpoint.wind;
}

function rainValue(checkpoint: Checkpoint): number | null {
  return checkpoint.rain;
}

function snowValue(checkpoint: Checkpoint): number | null {
  return checkpoint.snow;
}

/** The first column is the default sort and the row header; it has no sort control of its own. */
const COLUMNS: readonly TableColumn<Checkpoint>[] = [
  {
    id: "index",
    header: t("table.cols.index"),
    isRowHeader: true,
    numeric: true,
    align: "start",
    sortValue: indexValue,
    cell: indexCell,
  },
  {
    id: "distance",
    header: t("table.cols.distance"),
    numeric: true,
    sortable: true,
    sortValue: distanceValue,
    cell: distanceCell,
  },
  {
    id: "eta",
    header: t("table.cols.eta"),
    numeric: true,
    sortable: true,
    sortValue: etaValue,
    cell: etaCell,
  },
  {
    id: "level",
    header: t("table.cols.level"),
    sortable: true,
    sortValue: levelValue,
    cell: levelCell,
  },
  {
    id: "wind",
    header: t("table.cols.wind"),
    numeric: true,
    sortable: true,
    sortValue: windValue,
    cell: windCell,
  },
  { id: "gust", header: t("table.cols.gust"), numeric: true, cell: gustCell },
  {
    id: "rain",
    header: t("table.cols.rain"),
    numeric: true,
    sortable: true,
    sortValue: rainValue,
    cell: rainCell,
  },
  {
    id: "snow",
    header: t("table.cols.snow"),
    numeric: true,
    sortable: true,
    sortValue: snowValue,
    cell: snowCell,
  },
  { id: "temp", header: t("table.cols.temp"), numeric: true, cell: tempCell },
  { id: "loadRule", header: t("table.cols.loadRule"), cell: loadRuleCell },
];

export const demo: Demo = {
  name: "Table",
  description:
    "The checkpoints table: sortable columns, one selectable row, and a keyboard-reachable scroll region that keeps its header in view.",
  states: [
    {
      id: "default",
      title: "Sorted by #, checkpoint 4 selected, checkpoint 6 without weather data",
      node: (
        <Table
          regionLabel={t("table.regionLabel", { route: "B" })}
          columns={COLUMNS}
          rows={CHECKPOINTS}
          getRowId={checkpointId}
          selectedKey="4"
        />
      ),
    },
    {
      id: "sorted-descending",
      title: "Sorted descending by wind: the checkpoint without data stays last",
      node: (
        <Table
          regionLabel={t("table.regionLabel", { route: "A" })}
          columns={COLUMNS}
          rows={CHECKPOINTS}
          getRowId={checkpointId}
          defaultSortDescriptor={WIND_DESCENDING}
        />
      ),
    },
    {
      id: "empty",
      title: "Empty",
      node: (
        <Table
          regionLabel={t("table.regionLabel", { route: "C" })}
          columns={COLUMNS}
          rows={NO_CHECKPOINTS}
          getRowId={checkpointId}
        />
      ),
    },
  ],
};
