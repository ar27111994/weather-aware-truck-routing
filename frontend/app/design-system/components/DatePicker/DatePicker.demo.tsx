import { CalendarDate, CalendarDateTime } from "@internationalized/date";
import { useState, type ReactElement } from "react";
import { I18nProvider, type DateValue } from "react-aria-components";

import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { ActionChip } from "../Chip";
import { DatePicker } from "./DatePicker";

/** A fixed "now" so the visual goldens never move. */
const NOW = new CalendarDateTime(2026, 10, 21, 14, 30);

const QUICK_CHIPS = [
  { label: t("form.departure.chips.now"), value: NOW },
  { label: t("form.departure.chips.plus3h"), value: NOW.add({ hours: 3 }) },
  {
    label: t("form.departure.chips.tomorrow0600"),
    value: new CalendarDateTime(2026, 10, 22, 6, 0),
  },
] as const;

/** The planner's departure field: the date, the time and the quick chips share one value. */
function DepartureWithChips(): ReactElement {
  const [value, setValue] = useState<DateValue | null>(NOW);
  return (
    <DatePicker
      label={t("form.departure.label")}
      description={t("form.departure.zoneHint", { zone: "MDT", offset: "UTC\u22126" })}
      granularity="minute"
      value={value}
      onChange={setValue}
      quickChips={QUICK_CHIPS.map((chip) => (
        <ActionChip
          key={chip.label}
          onPress={() => {
            setValue(chip.value);
          }}
        >
          {chip.label}
        </ActionChip>
      ))}
    />
  );
}

/** What the `/design` route renders for DatePicker: the locale-driven field in every state. */
export const demo: Demo = {
  name: "DatePicker",
  description: "Date and time field with a locale-driven calendar and a quick-chip slot.",
  states: [
    {
      id: "departure-en-us",
      title: "Date and time with quick chips, en-US (12-hour clock)",
      node: (
        <I18nProvider locale="en-US">
          <DepartureWithChips />
        </I18nProvider>
      ),
    },
    {
      id: "date-en-gb",
      title: "Date only, en-GB (day first)",
      node: (
        <I18nProvider locale="en-GB">
          <DatePicker
            label={t("form.departure.dateLabel")}
            defaultValue={new CalendarDate(2026, 10, 21)}
          />
        </I18nProvider>
      ),
    },
    {
      id: "invalid",
      title: "Invalid",
      node: (
        <I18nProvider locale="en-US">
          <DatePicker
            label={t("form.departure.dateLabel")}
            defaultValue={new CalendarDate(2026, 10, 30)}
            maxValue={new CalendarDate(2026, 10, 25)}
            errorMessage={t("form.departure.error.range")}
          />
        </I18nProvider>
      ),
    },
    {
      id: "disabled",
      title: "Disabled",
      node: (
        <I18nProvider locale="en-US">
          <DatePicker
            label={t("form.departure.dateLabel")}
            defaultValue={new CalendarDate(2026, 10, 21)}
            isDisabled
          />
        </I18nProvider>
      ),
    },
    {
      id: "read-only",
      title: "Read only",
      node: (
        <I18nProvider locale="en-US">
          <DatePicker
            label={t("form.departure.dateLabel")}
            defaultValue={new CalendarDate(2026, 10, 21)}
            isReadOnly
          />
        </I18nProvider>
      ),
    },
  ],
};
