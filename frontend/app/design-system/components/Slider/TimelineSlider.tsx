import { useMemo } from "react";
import type { ReactElement } from "react";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { Skeleton } from "../Skeleton";
import { Slider } from "./Slider";
import styles from "./Slider.module.css";
import {
  LABEL_EVERY_HOURS,
  createTimelineFormatters,
  describeTimelineValue,
  timelineMarks,
} from "./timeline";
import type { TimelineClock, TimelineFormatters, TimelineMarks } from "./timeline";

/** Length of the forecast timeline in hours. */
export const TIMELINE_HOURS = 48;

/**
 * Geometry of the scale's SVG, in user units (CSS px). SVG attributes cannot read a custom property,
 * so each value mirrors the component token named beside it; the tests fail if a value drifts.
 */
export const SCALE = {
  /** `--c-slider-scale-day-label-y`: baseline of the weekday label. */
  dayLabelY: 10,
  /** `--c-slider-scale-day-rule-top`: where a midnight rule starts. */
  dayRuleTop: 14,
  /** `--c-slider-scale-days-height`: the strip above the track, and where a midnight rule ends. */
  daysHeight: 34,
  /** `--c-slider-scale-tick-length`: an hour tick. */
  tickLength: 6,
  /** `--c-slider-scale-tick-length-major`: every sixth hour. */
  tickLengthMajor: 10,
  /** `--c-slider-scale-tick-label-y`: baseline of the `+6 h` labels. */
  tickLabelY: 24,
} as const;

export interface TimelineSliderProps extends TimelineClock {
  /** Length of the timeline in hours. */
  readonly hours?: number;
  /** Controlled position, in hours after departure. */
  readonly value?: number;
  readonly defaultValue?: number;
  readonly onChange?: (hour: number) => void;
  readonly onChangeEnd?: (hour: number) => void;
  /** Frames are not ready: a skeleton track and the loading caption replace the slider. */
  readonly isLoading?: boolean;
  /** Accessible name; defaults to "Forecast time". */
  readonly label?: string;
  readonly className?: string;
}

/**
 * The formatters for a clock, built once per departure instant, zone and locale. The departure is
 * compared as a number, so a parent that passes a new `Date` for the same instant on every render
 * does not rebuild them (R1-06).
 */
function useTimelineFormatters(
  departure: Date | number,
  timeZone: string | undefined,
  locale: string | undefined,
): TimelineFormatters {
  const departureMs = new Date(departure).getTime();
  return useMemo(
    () =>
      createTimelineFormatters({
        departure: departureMs,
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(locale === undefined ? {} : { locale }),
      }),
    [departureMs, timeZone, locale],
  );
}

/** Percent along the track, rounded so the markup stays short and stable. */
function percent(hour: number, hours: number): string {
  return `${String(Number(((hour / hours) * 100).toFixed(4)))}%`;
}

function DayMarkers({
  marks,
  hours,
}: {
  readonly marks: TimelineMarks;
  readonly hours: number;
}): ReactElement {
  return (
    <svg className={styles.days} data-scale="days" aria-hidden="true" focusable="false">
      {marks.days.map((day) => (
        <g key={day.hour}>
          <text
            className={styles.dayLabel}
            x={percent(day.hour, hours)}
            y={SCALE.dayLabelY}
            textAnchor="middle"
          >
            {day.weekday}
          </text>
          <line
            className={styles.dayRule}
            x1={percent(day.hour, hours)}
            x2={percent(day.hour, hours)}
            y1={SCALE.dayRuleTop}
            y2={SCALE.daysHeight}
          />
        </g>
      ))}
    </svg>
  );
}

function HourTicks({
  marks,
  hours,
}: {
  readonly marks: TimelineMarks;
  readonly hours: number;
}): ReactElement {
  const labelled = new Set(marks.labels.map((label) => label.hour));
  return (
    <svg className={styles.ticks} data-scale="ticks" aria-hidden="true" focusable="false">
      {marks.hours
        .filter((hour) => !labelled.has(hour))
        .map((hour) => (
          <line
            key={hour}
            className={styles.tick}
            x1={percent(hour, hours)}
            x2={percent(hour, hours)}
            y1={0}
            y2={SCALE.tickLength}
          />
        ))}
      {marks.labels.map((label) => (
        <g key={label.hour}>
          <line
            className={styles.tick}
            x1={percent(label.hour, hours)}
            x2={percent(label.hour, hours)}
            y1={0}
            y2={SCALE.tickLengthMajor}
          />
          <text
            className={styles.tickLabel}
            x={percent(label.hour, hours)}
            y={SCALE.tickLabelY}
            // The last label hangs from its tick inward, so it never runs past the end of the track.
            textAnchor={label.hour === hours ? "end" : "middle"}
          >
            {label.text}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * The forecast timeline slider (DESIGN.md sections 9.10 and 10): 0 to 48 hours after departure,
 * a tick every hour, a labelled tick every sixth hour, local midnights marked with the weekday, and
 * a spoken value like "Tue 2:00 PM, +6 hours" ("departure" at +0). Arrow keys move one hour, Page
 * Up and Page Down six, Home and End jump to the ends. The map card adds Play and the readout.
 */
export function TimelineSlider({
  departure,
  timeZone,
  locale,
  hours = TIMELINE_HOURS,
  isLoading = false,
  label = t("timeline.label"),
  className,
  ...sliderProps
}: TimelineSliderProps): ReactElement {
  const formatters = useTimelineFormatters(departure, timeZone, locale);
  const marks = useMemo(() => timelineMarks(formatters, hours), [formatters, hours]);
  const formatValue = useMemo(
    () =>
      (hour: number): string =>
        describeTimelineValue(formatters, hour).valueText,
    [formatters],
  );

  if (isLoading) {
    return (
      <div aria-busy="true" className={cx(styles.loading, className)}>
        <Skeleton height="block" />
        <p role="status" className={styles.loadingText}>
          {t("timeline.loading")}
        </p>
      </div>
    );
  }
  return (
    <Slider
      {...sliderProps}
      label={label}
      isLabelHidden
      minValue={0}
      maxValue={hours}
      step={1}
      pageStep={LABEL_EVERY_HOURS}
      formatValue={formatValue}
      above={<DayMarkers marks={marks} hours={hours} />}
      below={<HourTicks marks={marks} hours={hours} />}
      {...(className === undefined ? {} : { className })}
    />
  );
}

export interface TimelineReadoutProps extends TimelineClock {
  /** Position in hours after departure. */
  readonly hour: number;
  readonly className?: string;
}

/**
 * The dock's readout: local time in the data style with the offset under it. It repeats what the
 * slider already says aloud, so it is hidden from assistive technology.
 */
export function TimelineReadout({
  hour,
  className,
  departure,
  timeZone,
  locale,
}: TimelineReadoutProps): ReactElement {
  const reading = describeTimelineValue(useTimelineFormatters(departure, timeZone, locale), hour);
  return (
    <div aria-hidden="true" className={cx(styles.readout, className)}>
      <span className={styles.readoutTime}>
        {reading.weekday} {reading.time} {reading.zone}
      </span>
      <span className={styles.readoutOffset}>{reading.offset}</span>
    </div>
  );
}
