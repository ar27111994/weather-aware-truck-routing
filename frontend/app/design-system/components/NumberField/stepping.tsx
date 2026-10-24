import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ButtonContext,
  InputContext,
  NumberFieldStateContext,
  useLocale,
  useSlottedContext,
  type PressEvent,
} from "react-aria-components";
import type { NumberFieldState } from "react-stately";

/** Delay before a held stepper starts to repeat, for mouse, pen, keyboard and screen readers. */
const REPEAT_DELAY_MS = 400;

/** The same delay for touch, so that a finger that only scrolls past the button does not step. */
const TOUCH_REPEAT_DELAY_MS = 600;

/** Time between two repeats while a stepper is held down. */
const REPEAT_INTERVAL_MS = 60;

/** Which way a step goes: `1` adds the step, `-1` takes it away. */
type Direction = 1 | -1;

/** The keys that step the value, as React Aria's spin button defines them. */
const STEP_KEYS: Readonly<Record<string, Direction | undefined>> = {
  ArrowUp: 1,
  PageUp: 1,
  ArrowDown: -1,
  PageDown: -1,
};

/**
 * Where one step leaves the value: exactly `step` from the number in the field now (typed text
 * that is not committed yet counts), kept inside the limits. An empty field starts at the limit
 * the step points away from, or at zero when there is none, which is where React Aria starts too.
 */
export function steppedValue(state: NumberFieldState, direction: Direction, step: number): number {
  const { numberValue, minValue, maxValue } = state;
  if (Number.isNaN(numberValue)) return (direction === 1 ? minValue : maxValue) ?? 0;
  const moved = numberValue + direction * step;
  return Math.min(Math.max(moved, minValue ?? -Infinity), maxValue ?? Infinity);
}

/** What the timers of a held stepper read: the field as of its latest render. */
interface Latest {
  readonly state: NumberFieldState;
  readonly step: number;
  readonly locale: string;
  readonly inputId: string;
}

/**
 * The stepping of one field, kept in an object of its own: a held stepper outlives the render that
 * started it, and the field changes under its timers, so they read `latest` instead of what they
 * were created with.
 */
class Stepping {
  private latest: Latest;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private spun = false;

  constructor(latest: Latest) {
    this.latest = latest;
  }

  /** Hands over the field as of the render that just committed. */
  readonly update = (latest: Latest): void => {
    this.latest = latest;
  };

  /** Ends a held press: nothing repeats any more. */
  readonly stop = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  };

  /**
   * Takes one step. At a limit the value stays where it is, and React Aria disables the stepper,
   * which ends the press and so the repeat.
   */
  readonly step = (direction: Direction): void => {
    const { state, step, locale } = this.latest;
    const next = steppedValue(state, direction, step);
    // `commit` takes the text of a value, formats it and clamps it, as for typed input.
    state.commit(
      new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 20 }).format(next),
    );
  };

  private repeat(direction: Direction, delay: number): void {
    this.timer = setTimeout(() => {
      this.spun = true;
      this.step(direction);
      this.repeat(direction, REPEAT_INTERVAL_MS);
    }, delay);
  }

  readonly pressStart = (direction: Direction, event: PressEvent): void => {
    this.stop();
    this.spun = false;
    // React Aria keeps focus off the buttons. With the mouse the field takes it, so that typing and
    // the arrow keys carry on from there; with touch or a screen reader the pressed button keeps
    // it, so that the software keyboard stays away and the reader's cursor stays on the button.
    const input = document.getElementById(this.latest.inputId);
    if (document.activeElement !== input) {
      // React Aria hands over the pressed element as an `Element`; a stepper is a button.
      const focused = event.pointerType === "mouse" ? input : (event.target as HTMLElement);
      focused?.focus();
    }
    const touch = event.pointerType === "touch";
    if (!touch) this.step(direction);
    this.repeat(direction, touch ? TOUCH_REPEAT_DELAY_MS : REPEAT_DELAY_MS);
  };

  readonly press = (direction: Direction, event: PressEvent): void => {
    // A touch steps on release, and only if the press was not already repeating.
    if (event.pointerType === "touch" && !this.spun) this.step(direction);
  };
}

/** The field's state, which only exists inside a {@link NumberField}. */
function useFieldState(): NumberFieldState {
  const state = useContext(NumberFieldStateContext);
  if (state === null) throw new Error("StepBridge must render inside a NumberField.");
  return state;
}

/**
 * Re-points the field's steppers and its arrow and page keys at `step`.
 *
 * React Aria's own stepping snaps the value to a grid of `step` and, with a step set, also snaps
 * what the user types to it, so a typed 30,400 became 30,000 (R3-02, R4-06). The design wants
 * both: the steppers move by `step`, and typing allows any number. So the field is given no step
 * at all (typing is only clamped to the limits), and this bridge takes over the stepping: it
 * keeps React Aria's buttons (names, tab order, disabled states) and keys, and replaces what a
 * press or an arrow key does, the way the library does it: a step at once, then repeating while
 * a stepper is held.
 */
export function StepBridge({
  step,
  inputId,
  children,
}: {
  /** What one step adds or takes away. */
  readonly step: number;
  /** The `id` of the field's input. */
  readonly inputId: string;
  readonly children: ReactNode;
}): ReactElement {
  const state = useFieldState();
  const { locale } = useLocale();
  const input = useSlottedContext(InputContext);
  const increment = useSlottedContext(ButtonContext, "increment");
  const decrement = useSlottedContext(ButtonContext, "decrement");
  const [stepping] = useState(() => new Stepping({ state, step, locale, inputId }));
  useLayoutEffect(() => {
    stepping.update({ state, step, locale, inputId });
  });
  useEffect(() => stepping.stop, [stepping]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const direction = STEP_KEYS[event.key];
    const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
    const canStep = direction === 1 ? state.canIncrement : state.canDecrement;
    if (direction === undefined || modified || event.nativeEvent.isComposing || !canStep) {
      input?.onKeyDown?.(event);
      return;
    }
    event.preventDefault();
    stepping.step(direction);
  };

  return (
    <InputContext.Provider value={{ ...input, onKeyDown }}>
      <ButtonContext.Provider
        value={{
          slots: {
            increment: {
              ...increment,
              onPressStart: (event) => {
                stepping.pressStart(1, event);
              },
              onPress: (event) => {
                stepping.press(1, event);
              },
              onPressEnd: stepping.stop,
            },
            decrement: {
              ...decrement,
              onPressStart: (event) => {
                stepping.pressStart(-1, event);
              },
              onPress: (event) => {
                stepping.press(-1, event);
              },
              onPressEnd: stepping.stop,
            },
          },
        }}
      >
        {children}
      </ButtonContext.Provider>
    </InputContext.Provider>
  );
}
