import type { Checkpoint, Route } from "../../api/contract";
import type { MilesByLevel } from "../../design-system/components/StackedBar/geometry";
import { t } from "../../design-system/foundation/strings";
import { at } from "../../lib/checked";
import { formatDuration, formatLocalTime, formatMiles } from "../../lib/format";
import { riskLabel } from "../../lib/risk";

/** A checkpoint's ETA on the clock of the place it is in: `Tue 2:20 PM MDT`. */
export function checkpointClock(checkpoint: Checkpoint, locale: string): string {
  return formatLocalTime(checkpoint.eta, checkpoint, { locale });
}

/** When a route arrives, on the clock of its destination (the last checkpoint's zone). */
export function arrivalClock(route: Route, locale: string): string {
  const destination = at(route.checkpoints, route.checkpoints.length - 1);
  return formatLocalTime(route.arrival_time, destination, { locale });
}

/** When a route departs, on the clock of its origin (the first checkpoint's zone). */
export function departureClock(route: Route, locale: string): string {
  const origin = at(route.checkpoints, 0);
  return formatLocalTime(route.departure_time, origin, { locale });
}

/** The bar's input: miles at each level, with the miles that have no weather as Unknown. */
export function milesByLevel(route: Route): MilesByLevel {
  return { ...route.stats.miles_by_level, unknown: route.stats.unknown_mi };
}

/** The accessible name of a route card: its letter, whether it is recommended, and the headline numbers. */
export function routeCardLabel(route: Route): string {
  return t("route.cardAria", {
    route: route.route_id,
    recommended: route.recommended ? t("route.recommendedAria") : "",
    distance: formatMiles(route.distance_mi, { unit: false }),
    duration: formatDuration(route.duration_s),
    level: riskLabel(route.stats.max_level),
  });
}

/** Average risk as the domain compares it (three decimals), or the Unknown word when nothing was assessed. */
export function averageRiskText(route: Route): string {
  return route.stats.avg_risk === null ? t("risk.unknown") : route.stats.avg_risk.toFixed(3);
}

/** The readings a checkpoint carries, each shown at the precision the domain classifies it at. */
const READING_DIGITS = { wind: 1, gust: 1, rain: 3, snow: 3, temp: 0 } as const;

/** One of the readings of a checkpoint's weather. */
export type Reading = keyof typeof READING_DIGITS;

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${String(digits)}`;
  const cached = numberFormats.get(key);
  if (cached !== undefined) return cached;
  const created = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  numberFormats.set(key, created);
  return created;
}

/**
 * A weather reading for a table cell, without its unit (the column header carries it): wind and
 * gusts to a tenth, rain and snow to a thousandth so a value never contradicts its level, and
 * temperature to a whole degree (never `-0`). A missing reading says so in words.
 */
export function weatherValue(value: number | null, reading: Reading, locale: string): string {
  if (value === null) return t("popover.missing");
  const rounded = reading === "temp" ? Math.round(value) + 0 : value;
  return numberFormat(locale, READING_DIGITS[reading]).format(rounded);
}
