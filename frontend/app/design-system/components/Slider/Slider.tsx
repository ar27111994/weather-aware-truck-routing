import { useMemo, useRef } from "react";
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from "react";
import { mergeProps, useFocusRing, useHover, useSlider, useSliderThumb } from "react-aria";
import { useSliderState } from "react-stately";
import type { SliderState } from "react-stately";

import { cx } from "../../foundation/cx";
import { VisuallyHidden } from "../VisuallyHidden";
import styles from "./Slider.module.css";

export interface SliderProps {
  /** Accessible name. Shown above the track unless `isLabelHidden`. */
  readonly label: string;
  /** Keep the label for assistive technology only (the timeline names itself elsewhere). */
  readonly isLabelHidden?: boolean;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly step?: number;
  /** Controlled value. */
  readonly value?: number;
  /** Uncontrolled initial value; defaults to `minValue`. */
  readonly defaultValue?: number;
  readonly onChange?: (value: number) => void;
  /** Called once when a drag or a key press settles. */
  readonly onChangeEnd?: (value: number) => void;
  readonly isDisabled?: boolean;
  /**
   * Text for a value: read by screen readers (`aria-valuetext`) and shown by `showValue`. Defaults
   * to the plain number.
   */
  readonly formatValue?: (value: number) => string;
  /** Show the formatted value beside the label. */
  readonly showValue?: boolean;
  /** What Page Up and Page Down move by. Defaults to a tenth of the range. */
  readonly pageStep?: number;
  /** Decoration above the track that shares its width, such as the timeline's weekday markers. */
  readonly above?: ReactNode;
  /** Decoration below the track that shares its width, such as the timeline's hour ticks. */
  readonly below?: ReactNode;
  readonly className?: string;
}

function plainNumber(value: number): string {
  return String(value);
}

/**
 * The slider state only ever asks its formatter to turn a value into text. This formatter is that
 * function, so a slider can read "Tue 2:00 PM, +6 hours" aloud where React Aria Components would
 * only offer a formatted number.
 */
class ValueFormatter extends Intl.NumberFormat {
  readonly #render: (value: number) => string;

  constructor(render: (value: number) => string) {
    super("en-US");
    this.#render = render;
  }

  override format(value: number): string {
    return this.#render(value);
  }
}

interface ThumbProps {
  readonly state: SliderState;
  readonly trackRef: RefObject<HTMLDivElement | null>;
  readonly isDisabled: boolean;
  readonly pageStep: number | undefined;
}

function Thumb({ state, trackRef, isDisabled, pageStep }: ThumbProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const { thumbProps, inputProps, isDragging } = useSliderThumb(
    { index: 0, trackRef, inputRef, isDisabled },
    state,
  );
  const { focusProps, isFocusVisible } = useFocusRing();
  const { hoverProps, isHovered } = useHover({ isDisabled });

  // React Aria pages by a tenth of the range; a slider can ask for its own jump (6 hours for the
  // timeline). The capture handler runs first and stops the default page move.
  const pageByStep = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (pageStep === undefined || (event.key !== "PageUp" && event.key !== "PageDown")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "PageUp" ? 1 : -1;
    state.setThumbDragging(0, true);
    state.setThumbValue(0, state.getThumbValue(0) + direction * pageStep);
    state.setThumbDragging(0, false);
  };

  return (
    <div
      {...mergeProps(thumbProps, hoverProps)}
      onKeyDownCapture={pageByStep}
      className={styles.thumb}
      data-dragging={isDragging}
      data-hovered={isHovered}
      data-focus-visible={isFocusVisible}
      data-disabled={isDisabled}
    >
      <VisuallyHidden>
        <input ref={inputRef} {...mergeProps(inputProps, focusProps)} />
      </VisuallyHidden>
    </div>
  );
}

/**
 * Single-thumb slider (DESIGN.md section 10): a 4 px track, an ink fill and a 24 px ink thumb with
 * a raised ring. Built on the React Aria hooks so the spoken value can be any text, not only a
 * number. Keys: arrows by `step`, Page Up and Page Down by `pageStep`, Home and End to the ends.
 */
export function Slider({
  label,
  isLabelHidden = false,
  minValue = 0,
  maxValue = 100,
  step = 1,
  value,
  defaultValue,
  onChange,
  onChangeEnd,
  isDisabled = false,
  formatValue = plainNumber,
  showValue = false,
  pageStep,
  above,
  below,
  className,
}: SliderProps): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null);
  const numberFormatter = useMemo(() => new ValueFormatter(formatValue), [formatValue]);
  const sliderProps = {
    label,
    minValue,
    maxValue,
    step,
    isDisabled,
    defaultValue: defaultValue ?? minValue,
    ...(value === undefined ? {} : { value }),
    ...(onChange === undefined ? {} : { onChange }),
    ...(onChangeEnd === undefined ? {} : { onChangeEnd }),
  };
  const state = useSliderState<number>({ ...sliderProps, numberFormatter });
  const { groupProps, trackProps, labelProps, outputProps } = useSlider(
    sliderProps,
    state,
    trackRef,
  );
  const labelNode = (
    <label {...labelProps} className={styles.label}>
      {label}
    </label>
  );

  return (
    <div {...groupProps} className={cx(styles.slider, className)}>
      <div className={styles.header}>
        {isLabelHidden ? <VisuallyHidden>{labelNode}</VisuallyHidden> : labelNode}
        {showValue ? (
          <output {...outputProps} className={styles.output}>
            {state.getThumbValueLabel(0)}
          </output>
        ) : null}
      </div>
      <div className={styles.control}>
        {above}
        <div {...trackProps} ref={trackRef} className={styles.track} data-disabled={isDisabled}>
          <div className={styles.rail} />
          <div
            className={styles.fill}
            style={{ inlineSize: `${String(state.getThumbPercent(0) * 100)}%` }}
          />
          <Thumb state={state} trackRef={trackRef} isDisabled={isDisabled} pageStep={pageStep} />
        </div>
        {below}
      </div>
    </div>
  );
}
