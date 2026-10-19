import type { ReactElement } from "react";
import { DateInput, DateSegment, type DateInputProps } from "react-aria-components";

import { cls } from "../../cls";
import { fieldControlClass } from "../FieldParts";
import styles from "./Segments.module.css";

/** Props for {@link Segments}: the date input minus its styling hooks and children. */
export type SegmentsProps = Omit<DateInputProps, "className" | "style" | "children">;

/**
 * The editable segments of a date or time field inside the shared control box. Segment order and
 * the 12 / 24-hour clock come from the user's locale; the focused segment gets an ink fill with
 * on-ink text and empty (placeholder) segments are tertiary.
 */
export function Segments(props: SegmentsProps): ReactElement {
  return (
    <DateInput {...props} className={cls(fieldControlClass, styles["segments"])}>
      {(segment) => <DateSegment segment={segment} className={cls(styles["segment"])} />}
    </DateInput>
  );
}
