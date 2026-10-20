import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  Button,
  ButtonContext,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
  type DatePickerProps as AriaDatePickerProps,
  type DateValue,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldControlClass,
  fieldRootClass,
  type FieldErrorContent,
} from "../_shared/FieldParts";
import styles from "./DatePicker.module.css";

/** Props for {@link DatePicker}. */
export interface DatePickerProps extends Omit<
  AriaDatePickerProps<DateValue>,
  "className" | "style" | "children" | "validationBehavior" | "aria-label" | "hourCycle"
> {
  /** Visible label. Required: a placeholder is never a label. */
  readonly label: ReactNode;
  /** Caption under the field, for example the time-zone note. Read out with the field. */
  readonly description?: ReactNode;
  /** Error shown while the field is invalid (`isInvalid`, or a value outside min / max). */
  readonly errorMessage?: FieldErrorContent;
  /** Slot under the field group for one-shot quick chips such as Now, +3 h, Tomorrow 06:00. */
  readonly quickChips?: ReactNode;
}

/**
 * Date (and, with `granularity="minute"`, time) field with a calendar popover. Segment order and
 * the 12 / 24-hour clock follow the user's locale; so does the first day of the week.
 */
export function DatePicker({
  label,
  description,
  errorMessage,
  quickChips,
  ...props
}: DatePickerProps): ReactElement {
  return (
    <AriaDatePicker {...props} validationBehavior="aria" className={fieldRootClass}>
      <FieldLabel>{label}</FieldLabel>
      <Group className={cx(fieldControlClass, styles["group"])}>
        <DateInput className={cx(styles["segments"])}>
          {(segment) => <DateSegment segment={segment} className={cx(styles["segment"])} />}
        </DateInput>
        <Button className={cx(styles["toggle"])}>
          <CalendarDays size={20} aria-hidden="true" />
        </Button>
      </Group>
      {quickChips === undefined ? null : (
        <div className={cx(styles["chips"])}>
          {/* The picker's slotted context stops here, so a chip Button is a plain button. */}
          <ButtonContext.Provider value={null}>{quickChips}</ButtonContext.Provider>
        </div>
      )}
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={cx(styles["popover"])}>
        <Dialog className={cx(styles["dialog"])}>
          <Calendar>
            <header className={cx(styles["header"])}>
              <Button slot="previous" className={cx(styles["nav"])}>
                <ChevronLeft size={20} aria-hidden="true" />
              </Button>
              <Heading className={cx(styles["heading"])} />
              <Button slot="next" className={cx(styles["nav"])}>
                <ChevronRight size={20} aria-hidden="true" />
              </Button>
            </header>
            <CalendarGrid className={cx(styles["grid"])}>
              {(date) => <CalendarCell date={date} className={cx(styles["cell"])} />}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </AriaDatePicker>
  );
}
