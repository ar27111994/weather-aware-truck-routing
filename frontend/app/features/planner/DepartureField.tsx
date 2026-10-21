import { useId, type ReactElement } from "react";
import { useLocale } from "react-aria";

import { ActionChip } from "../../design-system/components/Chip";
import { DatePicker } from "../../design-system/components/DatePicker";
import { TimeField } from "../../design-system/components/TimeField";
import { t, type StringKey } from "../../design-system/foundation/strings";
import {
  chipDeparture,
  dateFromField,
  departureDays,
  timeFromField,
  zoneNote,
  type Clock,
  type DepartureChip,
  type DepartureDraft,
} from "./departure";
import styles from "./DepartureField.module.css";

/** The quick choices under the field, in the order the design lists them. */
const CHIPS: readonly { readonly id: DepartureChip; readonly label: StringKey }[] = [
  { id: "now", label: "form.departure.chips.now" },
  { id: "plus3h", label: "form.departure.chips.plus3h" },
  { id: "tomorrow0600", label: "form.departure.chips.tomorrow0600" },
];

/** Props for {@link DepartureField}. */
export interface DepartureFieldProps {
  readonly value: DepartureDraft;
  readonly onChange: (value: DepartureDraft) => void;
  /** The visitor's clock; `null` while there is none (the prerendered page). */
  readonly clock: Clock | null;
  readonly errorMessage?: string | undefined;
}

/**
 * Departure date and time (R1) on the visitor's own wall clock, with the zone said in words beneath
 * and three one-press chips: Now, +3 h and Tomorrow 06:00. The date is limited to the API's window
 * and the clock follows the locale's hour cycle. The zone caption and the window need the visitor's
 * clock; without one (the prerendered page) the caption's line stays reserved and the chips wait.
 */
export function DepartureField({
  value,
  onChange,
  clock,
  errorMessage,
}: DepartureFieldProps): ReactElement {
  const { locale } = useLocale();
  const noteId = useId();
  const days = clock === null ? null : departureDays(clock.now(), clock.timeZone);
  const note = clock === null ? null : zoneNote(clock.now(), locale, clock.timeZone);
  return (
    <fieldset className={styles.group} aria-describedby={noteId}>
      <legend className={styles.legend}>{t("form.departure.label")}</legend>
      <div className={styles.fields}>
        <DatePicker
          label={t("form.departure.dateLabel")}
          value={value.date}
          onChange={(date) => {
            onChange({ ...value, date: dateFromField(date) });
          }}
          {...(days === null ? {} : { minValue: days.first, maxValue: days.last })}
          isInvalid={errorMessage !== undefined}
          {...(errorMessage === undefined ? {} : { errorMessage })}
        />
        <TimeField
          label={t("form.departure.timeLabel")}
          value={value.time}
          onChange={(time) => {
            onChange({ ...value, time: timeFromField(time) });
          }}
          granularity="minute"
          isInvalid={errorMessage !== undefined}
        />
      </div>
      <div className={styles.chips}>
        {CHIPS.map((chip) => (
          <ActionChip
            key={chip.id}
            isDisabled={clock === null}
            {...(clock === null
              ? {}
              : {
                  onPress: () => {
                    onChange(chipDeparture(chip.id, clock.now(), clock.timeZone));
                  },
                })}
          >
            {t(chip.label)}
          </ActionChip>
        ))}
      </div>
      <p id={noteId} className={styles.note}>
        {note === null ? "\u00a0" : t("form.departure.zoneHint", note)}
      </p>
    </fieldset>
  );
}
