import type { ReactElement } from "react";
import {
  DateInput,
  DateSegment,
  type DateInputProps,
  type DateSegmentProps,
} from "react-aria-components";

import { cx } from "../../foundation/cx";
import { fieldControlClass } from "../_shared/FieldParts";
import styles from "./Segments.module.css";

/** Props for {@link Segments}: the date input minus its styling hooks and children. */
export type SegmentsProps = Omit<DateInputProps, "className" | "style" | "children">;

/** One piece of a date or time field: a field (hour, minute, ...) or the text between them. */
type SegmentValue = DateSegmentProps["segment"];

const NARROW_NO_BREAK_SPACE = /\u202f/gu;

/**
 * The text between segments (the colon, the space before AM or PM) comes from the engine's ICU, and
 * engines disagree: newer ICU (Node, which prerenders the page; Firefox; WebKit) writes U+202F
 * NARROW NO-BREAK SPACE before AM or PM, and Chrome writes U+0020. A page written by one and
 * hydrated by another differs in one text node, and React then throws the whole tree away and
 * renders it again (error 418). Every literal is written with a plain space on both sides, so the
 * prerendered markup is the markup the browser makes, whichever browser it is.
 */
function withPlainSpaces(segment: SegmentValue): SegmentValue {
  return segment.type === "literal"
    ? { ...segment, text: segment.text.replace(NARROW_NO_BREAK_SPACE, " ") }
    : segment;
}

/**
 * The editable segments of a date or time field inside the shared control box. Segment order and
 * the 12 / 24-hour clock come from the user's locale; the focused segment gets an ink fill with
 * on-ink text and empty (placeholder) segments are tertiary.
 */
export function Segments(props: SegmentsProps): ReactElement {
  return (
    <DateInput {...props} className={cx(fieldControlClass, styles.segments)}>
      {(segment) => (
        <DateSegment segment={withPlainSpaces(segment)} className={cx(styles.segment)} />
      )}
    </DateInput>
  );
}
