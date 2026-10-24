import { useState } from "react";
import type { ReactElement } from "react";

export interface ControlledProps<Value> {
  /** What the parent starts with. */
  readonly initial: Value;
  /**
   * Called with every change the component asks for, after the parent has taken it. A test that
   * reads only what the screen shows has nothing to hear and leaves it out.
   */
  readonly onChange?: (value: Value) => void;
  /** Renders the component under test, controlled by the value and the setter it is given. */
  readonly children: (control: {
    readonly value: Value;
    readonly onChange: (next: Value) => void;
  }) => ReactElement;
}

/**
 * Holds the value a parent would hold. A component rendered inside it is controlled: the change it
 * asks for is stored here and the new value comes back down, and a test that listens hears about it
 * too.
 */
export function Controlled<Value>({
  initial,
  onChange,
  children,
}: ControlledProps<Value>): ReactElement {
  const [value, setValue] = useState(initial);
  return children({
    value,
    onChange: (next) => {
      setValue(next);
      onChange?.(next);
    },
  });
}
